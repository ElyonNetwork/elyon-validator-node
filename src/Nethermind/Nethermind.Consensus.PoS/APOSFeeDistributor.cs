// SPDX-License-Identifier: LGPL-3.0-only
//
// APOSFeeDistributor — UNPChain fee-distribution hook (v8 validator/delegator model).
//
// Runs at the END of every block's tx execution, BEFORE state-root finalisation,
// inside BlockProcessor.ProcessBlock. Mirrors UNPRegistry.creditTxFee() as
// direct storage mutations on the world state — no system tx, no gas, no signing.
//
// Determinism guarantee (unchanged from v7):
//   * Every node runs identical code on identical block input → identical
//     storage reads/writes → identical state roots. A divergent producer's
//     block is rejected by standard state-root validation.
//   * NO orphan-credits: settlement is atomic with the block.
//
// v8 MODEL (2026-06 redesign):
//   * The chain prices gas the DEFAULT Ethereum way (EIP-1559: base fee burned
//     by the standard transaction processor; producer receives only the
//     priority premium). This hook therefore shares ONLY what the producer
//     actually collected: premiumPerGas * gasUsed per tx.
//   * Token-share and contract-share NO LONGER EXIST (the token-owner /
//     contract-owner / marketplace model was removed).
//   * Relayer attribution (URELAY1 attestations in block ExtraData) maps each
//     tx to the APOS validator whose node relayed it. If that validator is
//     ACTIVE in the registry, it earns  collected * validator.gasShareBps/10000
//     — gasShareBps is the validator's ADMIN-SET TIER value, driven by its
//     pool volume (selfStake + delegated funds). The residual goes to admin.
//   * Txs with no (valid) attestation: the full collected fee goes to admin.
//     There is no equal-split fallback any more — fee share is earned by
//     relaying txs through your approved validator node, at your tier rate.
//
// Storage layout (UNPRegistry v8 — solc-verified 2026-06-10):
//   slot  6  →  mapping(address => Validator) validators
//   slot 17  →  uint256 adminAccumulatedFees
//   Validator struct offsets: status=+2, gasShareBps=+8, accumulatedFees=+10
//   ValidatorStatus: NONE=0, PENDING=1, ACTIVE=2, REJECTED=3, SUSPENDED=4

using System;
using Nethermind.Core;
using Nethermind.Core.Crypto;
using Nethermind.Core.Specs;
using Nethermind.Int256;
using Nethermind.Logging;
using Nethermind.State;
using Nethermind.Crypto;

namespace Nethermind.Consensus.PoS;

public sealed class APOSFeeDistributor
{
    private const int VALIDATORS_MAPPING_SLOT = 6;
    private const int ADMIN_FEES_SLOT         = 17;

    private const int VAL_STATUS_OFFSET    = 2;
    private const int VAL_GAS_SHARE_OFFSET = 8;
    private const int VAL_ACCUM_OFFSET     = 10;

    private const byte STATUS_ACTIVE = 2;
    private const ulong BPS_DENOM    = 10000;

    private readonly ILogger _logger;
    private readonly Address? _aposPointerAddress; // canonical, from chainspec
    private readonly long _relayerAttributionBlock; // 0 = disabled (all fees → admin)
    private readonly ulong _chainId;
    private readonly IEthereumEcdsa? _ecdsa;
    private readonly long _hardeningBlock;
    private const int SealLength = 65; // mirrors PoSSealer.ExtraSealLength

    public APOSFeeDistributor(Address? aposPointer, ILogManager logManager, long hardeningBlock = long.MaxValue)
    {
        _aposPointerAddress = aposPointer;
        _logger = logManager?.GetClassLogger() ?? NullLogger.Instance;
        _relayerAttributionBlock = 0;
        _chainId = 0;
        _ecdsa = null;
        _hardeningBlock = hardeningBlock;
    }

    public APOSFeeDistributor(Address? aposPointer, long relayerAttributionBlock, ulong chainId, IEthereumEcdsa ecdsa, ILogManager logManager, long hardeningBlock = long.MaxValue)
    {
        _hardeningBlock = hardeningBlock;
        _aposPointerAddress = aposPointer;
        _logger = logManager?.GetClassLogger() ?? NullLogger.Instance;
        _relayerAttributionBlock = relayerAttributionBlock;
        _chainId = chainId;
        _ecdsa = ecdsa;
    }

    /// <summary>
    /// Called by BlockProcessor after tx execution, before state-root finalisation.
    /// v8: per-tx collected premium is moved beneficiary → registry; the attested
    /// relaying validator earns its tier gasShareBps of it; admin gets the rest.
    /// </summary>
    public void Apply(Block block, TxReceipt[] receipts, IWorldState worldState, IReleaseSpec spec)
    {
        if (block is null || receipts is null || worldState is null) return;
        if (block.Transactions is null || block.Transactions.Length == 0) return;

        Address? registry = ResolveRegistryFromPointer(worldState);
        if (registry is null) return;
        if (!worldState.IsContract(registry)) return;

        // Relayer-attribution map (txHash → relayer), from URELAY1 attestations
        // in block.ExtraData. Invalid attestations are silently dropped (per-tx
        // fallback: fee → admin); never halt the chain.
        System.Collections.Generic.Dictionary<Hash256, Address>? relayerMap = null;
        bool relayerModeActive = _relayerAttributionBlock > 0
            && block.Number >= _relayerAttributionBlock
            && _ecdsa is not null;
        if (relayerModeActive)
        {
            try
            {
                RelayerAttestation[] atts = RelayerAttestationCodec.Decode(block.Header.ExtraData, SealLength);
                if (atts.Length > 0)
                {
                    relayerMap = new System.Collections.Generic.Dictionary<Hash256, Address>(atts.Length);
                    foreach (var att in atts)
                    {
                        if (RelayerAttestationCodec.Verify(att, _chainId, _ecdsa!))
                        {
                            if (!relayerMap.ContainsKey(att.TxHash))
                            {
                                relayerMap[att.TxHash] = att.Relayer;
                            }
                        }
                    }
                }
            }
            catch (Exception ex)
            {
                if (_logger.IsWarn) _logger.Warn($"[APOS] attestation decode failed at block {block.Number}: {ex.Message}");
                relayerMap = null;
            }
        }

        UInt256 baseFee = block.Header.BaseFeePerGas;
        UInt256 totalAdminAccrued     = UInt256.Zero;
        UInt256 totalValidatorAccrued = UInt256.Zero;
        int processed = 0;

        for (int i = 0; i < block.Transactions.Length && i < receipts.Length; i++)
        {
            Transaction tx = block.Transactions[i];
            TxReceipt rcpt = receipts[i];
            if (rcpt is null || tx is null) continue;

            // What the producer ACTUALLY collected for this tx under default
            // Ethereum fee handling: priority premium only (base fee is burned
            // by the standard processor). Pre-1559 blocks: baseFee == 0, so the
            // premium equals the full gas price — behaviour degrades gracefully.
            if (!tx.TryCalculatePremiumPerGas(baseFee, out UInt256 premiumPerGas)) continue;
            UInt256 gasUsed = (UInt256)rcpt.GasUsed;
            UInt256 collected = premiumPerGas * gasUsed;
            if (collected.IsZero) continue;

            // Registry-balance backing (v7.3.0 FIX-A, retained): standard EVM
            // crediting already added `collected` to the block's GasBeneficiary.
            // Move it beneficiary → registry so tracker claims are always
            // backed by real balance when validators/admin withdraw.
            Address? beneficiary = block.Header.GasBeneficiary;
            bool backed = false;
            if (beneficiary is not null && beneficiary != Address.Zero)
            {
                try
                {
                    worldState.SubtractFromBalance(beneficiary, collected, spec);
                    worldState.AddToBalance(registry, collected, spec);
                    backed = true;
                }
                catch (Exception ex)
                {
                    if (_logger.IsWarn)
                        _logger.Warn($"[APOS] beneficiary->registry transfer failed at block {block.Number} tx {i}: {ex.Message}");
                }
            }

            // From the hardening block a claim is only booked when the fee behind it
            // really reached the registry; otherwise a producer could spend the fee
            // and still leave a claim that other users' deposits would have to pay.
            if (!backed && block.Number >= _hardeningBlock) continue;

            // Attribute to the relaying validator at its tier rate.
            UInt256 validatorShare = UInt256.Zero;
            if (relayerMap is not null && rcpt.TxHash is not null && relayerMap.TryGetValue(rcpt.TxHash, out Address relayer))
            {
                UInt256 valBase = ComputeMapEntryBase(relayer, VALIDATORS_MAPPING_SLOT);
                if (ReadStatus(worldState, registry, valBase, VAL_STATUS_OFFSET) == STATUS_ACTIVE)
                {
                    UInt256 gasShareBps = ReadUInt256(worldState, registry, valBase + VAL_GAS_SHARE_OFFSET);
                    if (!gasShareBps.IsZero && gasShareBps < new UInt256(BPS_DENOM))
                    {
                        validatorShare = collected * gasShareBps / new UInt256(BPS_DENOM);
                        if (!validatorShare.IsZero)
                        {
                            IncrementStorage(worldState, registry, valBase + VAL_ACCUM_OFFSET, validatorShare);
                            totalValidatorAccrued += validatorShare;
                        }
                    }
                }
            }

            UInt256 adminShare = collected - validatorShare;
            if (!adminShare.IsZero) totalAdminAccrued += adminShare;

            processed++;
        }

        if (!totalAdminAccrued.IsZero)
        {
            IncrementStorage(worldState, registry, new UInt256(ADMIN_FEES_SLOT), totalAdminAccrued);
        }

        if (_logger.IsDebug)
            _logger.Debug($"[APOS] block {block.Number}: {processed} txs; validator={totalValidatorAccrued}, admin={totalAdminAccrued}");
    }

    // ─── Storage helpers ───────────────────────────────────────────

    private static UInt256 ComputeMapEntryBase(Address key, int mappingSlot)
    {
        // Solidity: slot = keccak256(abi.encode(key, slot))
        byte[] buf = new byte[64];
        key.Bytes.CopyTo(buf.AsSpan(12, 20));
        new UInt256((ulong)mappingSlot).ToBigEndian(buf.AsSpan(32));
        Hash256 hash = Keccak.Compute(buf);
        return new UInt256(hash.Bytes, isBigEndian: true);
    }

    private static UInt256 ReadUInt256(IWorldState ws, Address contract, UInt256 slot)
    {
        ReadOnlySpan<byte> data = ws.Get(new StorageCell(contract, slot));
        if (data.IsEmpty) return UInt256.Zero;
        return new UInt256(data, isBigEndian: true);
    }

    private static byte ReadStatus(IWorldState ws, Address contract, UInt256 baseSlot, int offset)
    {
        UInt256 slot = baseSlot + (UInt256)offset;
        ReadOnlySpan<byte> data = ws.Get(new StorageCell(contract, slot));
        if (data.IsEmpty) return 0;
        return data[data.Length - 1];
    }

    private static void IncrementStorage(IWorldState ws, Address contract, UInt256 slot, UInt256 delta)
    {
        if (delta.IsZero) return;
        StorageCell cell = new(contract, slot);
        ReadOnlySpan<byte> existing = ws.Get(cell);
        UInt256 current = existing.IsEmpty ? UInt256.Zero : new UInt256(existing, isBigEndian: true);
        UInt256 next = current + delta;
        byte[] buf = new byte[32];
        next.ToBigEndian(buf);
        int firstNonZero = 0;
        while (firstNonZero < buf.Length - 1 && buf[firstNonZero] == 0) firstNonZero++;
        ws.Set(cell, buf[firstNonZero..]);
    }

    // ─── Late-binding registry resolution ──────────────────────────

    /// <summary>
    /// Registry address resolved from on-chain APOSPointer.registry() (slot 1).
    /// APOSPointer's address comes from chainspec (engine.pos.params.aposPointer)
    /// — byte-identical across all nodes, the canonical trust anchor.
    /// </summary>
    private Address? ResolveRegistryFromPointer(IWorldState ws)
    {
        if (_aposPointerAddress is null) return null;
        if (!ws.IsContract(_aposPointerAddress)) return null;

        ReadOnlySpan<byte> data = ws.Get(new StorageCell(_aposPointerAddress, new UInt256(1)));
        if (data.IsEmpty) return null;
        byte[] addrBuf = new byte[20];
        int copyFrom = data.Length >= 20 ? data.Length - 20 : 0;
        int copyLen  = data.Length >= 20 ? 20 : data.Length;
        int dstStart = data.Length >= 20 ? 0 : 20 - data.Length;
        data.Slice(copyFrom, copyLen).CopyTo(addrBuf.AsSpan(dstStart, copyLen));
        Address addr = new Address(addrBuf);
        return addr == Address.Zero ? null : addr;
    }
}
