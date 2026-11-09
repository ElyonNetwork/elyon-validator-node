// SPDX-FileCopyrightText: 2024 Demerzel Solutions Limited
// SPDX-License-Identifier: LGPL-3.0-only

using System;
using System.Collections.Generic;
using System.Linq;
using System.Text;
using System.Threading;
using System.Threading.Tasks;
using Nethermind.Blockchain;
using Nethermind.Consensus.Processing;
using Nethermind.Consensus.Producers;
using Nethermind.Consensus.Transactions;
using Nethermind.Core;
using Nethermind.Core.Crypto;
using Nethermind.Core.Specs;
using Nethermind.Crypto;
using Nethermind.Int256;
using Nethermind.Evm.Tracing;
using Nethermind.Logging;
using Nethermind.State;
using Nethermind.State.Proofs;

namespace Nethermind.Consensus.PoS;

/// <summary>
/// Block producer for the PoS consensus engine.
/// Builds blocks with:
/// - Difficulty based on in-turn/out-of-turn proposer (like Clique)
/// - ExtraData containing vanity + validator list (on epoch) + seal
/// - Transactions selected from the tx pool
/// </summary>
public class PoSBlockProducer : IBlockProducer
{
    private readonly IWorldState _stateProvider;
    private readonly ITxSource _txSource;
    private readonly IBlockchainProcessor _processor;
    private readonly ISealer _sealer;
    private readonly IGasLimitCalculator _gasLimitCalculator;
    private readonly ISpecProvider _specProvider;
    private readonly ValidatorManager _validatorManager;
    private readonly ITimestamper _timestamper;
    private readonly long _transitionBlock;
    private readonly ulong _blockPeriod;
    private readonly ulong _epoch;
    private readonly ILogger _logger;

    public static readonly UInt256 DifficultyInTurn = new(2);
    public static readonly UInt256 DifficultyNoTurn = new(1);

    public PoSBlockProducer(
        ITxSource txSource,
        IBlockchainProcessor blockchainProcessor,
        IWorldState stateProvider,
        ITimestamper timestamper,
        ISealer sealer,
        IGasLimitCalculator gasLimitCalculator,
        ISpecProvider specProvider,
        ValidatorManager validatorManager,
        long transitionBlock,
        ulong blockPeriod,
        ulong epoch,
        ILogManager logManager)
    {
        _txSource = txSource ?? throw new ArgumentNullException(nameof(txSource));
        _processor = blockchainProcessor ?? throw new ArgumentNullException(nameof(blockchainProcessor));
        _stateProvider = stateProvider ?? throw new ArgumentNullException(nameof(stateProvider));
        _timestamper = timestamper ?? throw new ArgumentNullException(nameof(timestamper));
        _sealer = sealer ?? throw new ArgumentNullException(nameof(sealer));
        _gasLimitCalculator = gasLimitCalculator ?? throw new ArgumentNullException(nameof(gasLimitCalculator));
        _specProvider = specProvider ?? throw new ArgumentNullException(nameof(specProvider));
        _validatorManager = validatorManager ?? throw new ArgumentNullException(nameof(validatorManager));
        _transitionBlock = transitionBlock;
        _blockPeriod = blockPeriod;
        _epoch = epoch;
        _logger = logManager?.GetClassLogger() ?? throw new ArgumentNullException(nameof(logManager));
    }

    public async Task<Block?> BuildBlock(BlockHeader? parentHeader, IBlockTracer? blockTracer = null,
        PayloadAttributes? payloadAttributes = null, CancellationToken token = default)
    {
        if (parentHeader is null)
        {
            if (_logger.IsDebug) _logger.Debug("PoS: Cannot build block - no parent header");
            return null;
        }

        Block? block = PrepareBlock(parentHeader);
        if (block is null)
        {
            if (_logger.IsTrace) _logger.Trace("PoS: Block preparation failed or not allowed");
            return null;
        }

        if (_logger.IsInfo) _logger.Info($"PoS: Processing prepared block {block.Number}");
        Block? processedBlock = _processor.Process(
            block,
            ProcessingOptions.ProducingBlock,
            NullBlockTracer.Instance,
            token);

        if (processedBlock is null)
        {
            if (_logger.IsInfo) _logger.Info($"PoS: Prepared block {block.Number} lost the race");
            return null;
        }

        try
        {
            Block sealedBlock = await _sealer.SealBlock(processedBlock, token);
            if (_logger.IsInfo) _logger.Info($"PoS: Sealed block {sealedBlock.ToString(Block.Format.HashNumberDiffAndTx)}");
            return sealedBlock;
        }
        catch (OperationCanceledException)
        {
            if (_logger.IsInfo) _logger.Info($"PoS: Sealing block {processedBlock.Number} cancelled");
            return null;
        }
    }

    private Block? PrepareBlock(BlockHeader parentHeader)
    {
        if (parentHeader.Hash is null)
        {
            if (_logger.IsError) _logger.Error("PoS: Parent header hash is null");
            return null;
        }

        long blockNumber = parentHeader.Number + 1;

        if (!_sealer.CanSeal(blockNumber, parentHeader.Hash))
        {
            if (_logger.IsTrace) _logger.Trace($"PoS: Not allowed to seal block {blockNumber}");
            return null;
        }

        IReadOnlyList<Address> validators = _validatorManager.GetValidators(blockNumber, _transitionBlock);
        ulong timestamp = _timestamper.UnixTime.Seconds;
        if (!IsSlotOpen(_sealer.Address, validators, blockNumber, parentHeader.Timestamp, timestamp, _blockPeriod))
        {
            if (_logger.IsTrace) _logger.Trace($"PoS: Not this validator's slot for block {blockNumber}");
            return null;
        }

        if (_logger.IsInfo) _logger.Info($"PoS: Preparing new block {blockNumber} on top of {parentHeader}");

        ulong minTimestamp = parentHeader.Timestamp + _blockPeriod;
        if (timestamp < minTimestamp)
            timestamp = minTimestamp;

        bool isEpochBlock = _epoch > 0 && (ulong)blockNumber % _epoch == 0;

        // Calculate ExtraData size — base portion (vanity + optional signers + seal)
        int signerBytesLength = isEpochBlock ? Address.Size * validators.Count : 0;
        int baseExtraDataLength = PoSSealer.ExtraVanityLength + signerBytesLength + PoSSealer.ExtraSealLength;
        byte[] extraData = new byte[baseExtraDataLength];

        // Vanity bytes
        byte[] clientName = Encoding.UTF8.GetBytes($"PoS {ProductInfo.Version}");
        Array.Copy(clientName, extraData, Math.Min(clientName.Length, PoSSealer.ExtraVanityLength));

        // On epoch blocks, include the full validator list
        if (isEpochBlock)
        {
            for (int i = 0; i < validators.Count; i++)
            {
                Array.Copy(validators[i].Bytes, 0, extraData, PoSSealer.ExtraVanityLength + i * Address.Size, Address.Size);
            }
        }

        // Difficulty
        UInt256 difficulty = CalculateDifficulty(blockNumber, _sealer.Address, validators);

        // Set Beneficiary = sealer so GasBeneficiary resolves to the sealer
        // both at production time (where header.Author is also set below)
        // AND on disk-load / re-validation paths where header.Author is not
        // persisted in RLP. Without this, GasBeneficiary falls back to
        // Beneficiary=0x0 after every Nethermind restart and tx-bearing
        // blocks fail state-root validation against their stored values.
        BlockHeader header = new(
            parentHeader.Hash,
            Keccak.OfAnEmptySequenceRlp,
            _sealer.Address,
            difficulty,
            blockNumber,
            _gasLimitCalculator.GetGasLimit(parentHeader),
            timestamp,
            extraData);

        header.TotalDifficulty = parentHeader.TotalDifficulty + difficulty;
        header.MixHash = Keccak.Zero;
        header.Bloom = Bloom.Empty;

        var spec = _specProvider.GetSpec(header);
        header.BaseFeePerGas = BaseFeeCalculator.Calculate(parentHeader, spec);
        header.WithdrawalsRoot = spec.WithdrawalsEnabled ? Keccak.EmptyTreeHash : null;

        _stateProvider.StateRoot = parentHeader.StateRoot!;

        // Materialise selected txs first so we can look up attestations for them.
        var selectedTxsList = _txSource.GetTransactions(parentHeader, header.GasLimit, null, filterSource: true).ToList();

        // v7.3.0: load relayer attestations from /data/attestations/ for each
        // selected tx (written by the local dashboard's RPC proxy when this
        // node was the entry point). Embed them in extraData BEFORE the seal,
        // so they're covered by the seal automatically. If no attestation file
        // exists for a given tx, that tx's node-share falls back to equal-split
        // in the L2 hook. Errors here are non-fatal — we just produce the block
        // without attestations.
        try
        {
            byte[] attestationPrefix = ReadAttestationsForTxs(selectedTxsList);
            if (attestationPrefix.Length > 0)
            {
                // Reassemble extraData: [vanity (+epoch signers)] + [attestations] + [seal bytes]
                int newLen = (extraData.Length - PoSSealer.ExtraSealLength) + attestationPrefix.Length + PoSSealer.ExtraSealLength;
                byte[] newExtra = new byte[newLen];
                int prefixLen = extraData.Length - PoSSealer.ExtraSealLength;
                Array.Copy(extraData, 0, newExtra, 0, prefixLen);
                Array.Copy(attestationPrefix, 0, newExtra, prefixLen, attestationPrefix.Length);
                // Seal portion stays zero — PoSSealer fills it in after the hook runs.
                header.ExtraData = newExtra;
            }
        }
        catch (Exception ex)
        {
            if (_logger.IsWarn) _logger.Warn($"[APOS-L2] attestation lookup failed at block {blockNumber}: {ex.Message}");
        }

        Block block = new BlockToProduce(
            header,
            selectedTxsList,
            Array.Empty<BlockHeader>(),
            spec.WithdrawalsEnabled ? [] : null);

        header.TxRoot = TxTrie.CalculateRoot(block.Transactions);
        block.Header.Author = _sealer.Address;

        return block;
    }

    /// <summary>
    /// v7.3.0 — for each selected tx, read /data/attestations/&lt;txHash&gt;.bin
    /// if present. Each file is exactly 117 bytes: txHash(32) | relayer(20) |
    /// sig(65). Encode the collected list using RelayerAttestationCodec for
    /// embedding into block.ExtraData.
    /// </summary>
    private byte[] ReadAttestationsForTxs(System.Collections.Generic.List<Transaction> txs)
    {
        if (txs == null || txs.Count == 0) return Array.Empty<byte>();
        var list = new System.Collections.Generic.List<RelayerAttestation>(txs.Count);
        foreach (Transaction tx in txs)
        {
            Hash256? h = tx?.Hash;
            if (h is null && tx is not null)
            {
                try { h = tx.CalculateHash(); } catch { h = null; }
            }
            if (h is null) continue;
            // v7.4.0: primary path — query the in-process pool. The pool is
            // populated by the dashboard's eth_sendRawTransaction path (via
            // the FileSystemWatcher → AddLocal) AND by peer-inbound messages
            // (eth/68 UnpRelayerAttestation → AddRemote). Both paths verify
            // the secp256k1 signature before storing, so any entry returned
            // here is already known-valid.
            RelayerAttestation? att = RelayerAttestationPool.TryGet(h);
            if (att.HasValue)
            {
                list.Add(att.Value);
                continue;
            }
            // Fallback for legacy attestations sitting on disk that haven't
            // been ingested yet (e.g., during a startup race). Read the file
            // directly without verifying — the L2 hook re-verifies on import.
            string dataDir = Environment.GetEnvironmentVariable("DATA_DIR") ?? "/data";
            string attDir = System.IO.Path.Combine(dataDir, "attestations");
            string hex = h.ToString();
            if (hex.StartsWith("0x", StringComparison.OrdinalIgnoreCase)) hex = hex.Substring(2);
            string file = System.IO.Path.Combine(attDir, hex.ToLowerInvariant() + ".bin");
            if (!System.IO.File.Exists(file)) continue;
            byte[] bytes;
            try { bytes = System.IO.File.ReadAllBytes(file); }
            catch { continue; }
            if (bytes.Length != RelayerAttestationCodec.EntryLength) continue;
            byte[] hashBytes = new byte[32]; Array.Copy(bytes, 0, hashBytes, 0, 32);
            byte[] addr = new byte[20]; Array.Copy(bytes, 32, addr, 0, 20);
            byte[] sig  = new byte[65]; Array.Copy(bytes, 52, sig, 0, 65);
            list.Add(new RelayerAttestation(new Hash256(hashBytes), new Address(addr), sig));
        }
        if (list.Count == 0) return Array.Empty<byte>();
        return RelayerAttestationCodec.EncodePrefix(list.ToArray());
    }

    /// <summary>
    /// Only the in-turn validator builds at the normal block period. The others stay
    /// quiet until the out-of-turn window opens and then step in one after another,
    /// ordered by distance from the in-turn validator, so that one missing validator
    /// costs a short delay rather than several competing blocks.
    /// </summary>
    public static bool IsSlotOpen(Address signer, IReadOnlyList<Address> validators, long blockNumber, ulong parentTimestamp, ulong now, ulong blockPeriod)
    {
        int count = validators.Count;
        if (count <= 1)
        {
            return true;
        }

        int inTurn = (int)(blockNumber % count);
        int mine = -1;
        for (int i = 0; i < count; i++)
        {
            if (validators[i] == signer)
            {
                mine = i;
                break;
            }
        }

        if (mine < 0)
        {
            return false;
        }

        if (mine == inTurn)
        {
            return true;
        }

        ulong distance = (ulong)((mine - inTurn + count) % count);
        ulong earliest = parentTimestamp + PoSSealValidator.OutOfTurnBackoffSeconds + (distance - 1) * blockPeriod;
        return now >= earliest;
    }

    private UInt256 CalculateDifficulty(long blockNumber, Address signer, IReadOnlyList<Address> validators)
    {
        if (validators.Count == 0)
            return DifficultyNoTurn;

        int expectedIndex = (int)(blockNumber % validators.Count);
        bool inTurn = expectedIndex < validators.Count && validators[expectedIndex] == signer;

        return inTurn ? DifficultyInTurn : DifficultyNoTurn;
    }
}
