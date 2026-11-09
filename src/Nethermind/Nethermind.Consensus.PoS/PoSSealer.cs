// SPDX-FileCopyrightText: 2024 Demerzel Solutions Limited
// SPDX-License-Identifier: LGPL-3.0-only

using System;
using System.Threading;
using System.Threading.Tasks;
using Nethermind.Core;
using Nethermind.Core.Crypto;
using Nethermind.Crypto;
using Nethermind.Logging;

namespace Nethermind.Consensus.PoS;

/// <summary>
/// Seals PoS blocks by placing an ECDSA signature in the block's ExtraData field.
/// Uses the same format as Clique: 32 bytes vanity + 65 bytes seal.
/// </summary>
public class PoSSealer : ISealer
{
    private readonly ISigner _signer;
    private readonly ValidatorManager _validatorManager;
    private readonly long _transitionBlock;
    private readonly ILogger _logger;

    public const int ExtraVanityLength = 32;
    public const int ExtraSealLength = 65;

    public PoSSealer(ISigner signer, ValidatorManager validatorManager, long transitionBlock, ILogManager logManager)
    {
        _signer = signer ?? throw new ArgumentNullException(nameof(signer));
        _validatorManager = validatorManager ?? throw new ArgumentNullException(nameof(validatorManager));
        _transitionBlock = transitionBlock;
        _logger = logManager?.GetClassLogger() ?? throw new ArgumentNullException(nameof(logManager));
    }

    public Task<Block> SealBlock(Block block, CancellationToken cancellationToken)
    {
        Block sealedBlock = Seal(block);
        sealedBlock.Header.Hash = sealedBlock.Header.CalculateHash();
        return Task.FromResult(sealedBlock);
    }

    private Block Seal(Block block)
    {
        BlockHeader header = block.Header;
        long number = header.Number;

        if (number == 0)
            throw new InvalidOperationException("Cannot seal genesis block");

        // Calculate header hash for signing (exclude the seal portion of ExtraData)
        Hash256 headerHash = CalculateHeaderHashForSigning(header);

        // Sign the header hash
        Signature signature = _signer.Sign(headerHash);

        // Place signature in ExtraData: last 65 bytes (r[32] + s[32] + V[1])
        ReadOnlySpan<byte> signatureBytes = signature.Bytes;
        signatureBytes.CopyTo(header.ExtraData.AsSpan(header.ExtraData.Length - ExtraSealLength));
        // Store V (27/28) not RecoveryId (0/1) — Nethermind Signature(byte[65]) expects V >= 27
        header.ExtraData[^1] = (byte)signature.V;

        if (_logger.IsDebug) _logger.Debug($"PoS: Sealed block {number} with signer {_signer.Address}");

        return block;
    }

    /// <summary>
    /// Calculate the hash of the header for signing, excluding the seal bytes from ExtraData.
    /// v7.1.0 (audit N-I3): no longer mutates the live header in place — uses
    /// a clone to avoid races where concurrent gossip / RPC / re-org threads
    /// observe the stripped ExtraData and compute a different hash.
    /// </summary>
    public static Hash256 CalculateHeaderHashForSigning(BlockHeader header)
    {
        byte[] extraDataWithoutSeal = new byte[header.ExtraData.Length - ExtraSealLength];
        Array.Copy(header.ExtraData, extraDataWithoutSeal, extraDataWithoutSeal.Length);

        // Build a shallow clone for hash computation. CalculateHash reads the
        // exposed properties; cloning the header object is cheap relative to
        // the hashing cost itself, and crucially it never mutates `header`.
        BlockHeader clone = new(
            header.ParentHash,
            header.UnclesHash,
            header.Beneficiary,
            header.Difficulty,
            header.Number,
            header.GasLimit,
            header.Timestamp,
            extraDataWithoutSeal)
        {
            StateRoot = header.StateRoot,
            TxRoot = header.TxRoot,
            ReceiptsRoot = header.ReceiptsRoot,
            Bloom = header.Bloom,
            GasUsed = header.GasUsed,
            MixHash = header.MixHash,
            Nonce = header.Nonce,
            BaseFeePerGas = header.BaseFeePerGas,
            WithdrawalsRoot = header.WithdrawalsRoot,
            BlobGasUsed = header.BlobGasUsed,
            ExcessBlobGas = header.ExcessBlobGas,
            ParentBeaconBlockRoot = header.ParentBeaconBlockRoot,
            RequestsHash = header.RequestsHash,
        };
        return clone.CalculateHash();
    }

    public bool CanSeal(long blockNumber, Hash256 parentHash)
    {
        if (!_signer.CanSign)
        {
            if (_logger.IsTrace) _logger.Trace("PoS: Signer cannot sign");
            return false;
        }

        // Check if the signer is an authorized validator
        if (!_validatorManager.IsValidator(_signer.Address, blockNumber, _transitionBlock))
        {
            if (_logger.IsTrace) _logger.Trace($"PoS: Signer {_signer.Address} is not in the validator set for block {blockNumber}");
            return false;
        }

        return true;
    }

    public Address Address => _signer.Address;
}
