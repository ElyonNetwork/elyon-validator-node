// SPDX-FileCopyrightText: 2024 Demerzel Solutions Limited
// SPDX-License-Identifier: LGPL-3.0-only

using System;
using System.Collections.Generic;
using System.Linq;
using Nethermind.Core;
using Nethermind.Core.Crypto;
using Nethermind.Crypto;
using Nethermind.Int256;
using Nethermind.Logging;
using Nethermind.State;

namespace Nethermind.Consensus.PoS;

/// <summary>
/// Validates PoS block seals. Before the transition block, delegates to the base Clique validator.
/// After the transition block, validates that:
/// 1. The seal is a valid ECDSA signature
/// 2. The recovered signer is an authorized validator
/// 3. The signer is the expected proposer for this block (round-robin)
/// </summary>
public class PoSSealValidator : ISealValidator
{
    /// <summary>An out-of-turn validator may only step in this long after the parent block.</summary>
    public const ulong OutOfTurnBackoffSeconds = 10;

    /// <summary>How far ahead of the local clock a header's timestamp may be.</summary>
    public const ulong MaxFutureSeconds = 15;

    private readonly ISealValidator _baseValidator;
    private readonly ValidatorManager _validatorManager;
    private readonly long _transitionBlock;
    private readonly long _hardeningBlock;
    private readonly ulong _blockPeriod;
    private readonly ITimestamper _timestamper;
    private readonly IEthereumEcdsa _ecdsa;
    private readonly ILogger _logger;
    private IStateReader? _stateReader;

    public PoSSealValidator(
        ISealValidator baseValidator,
        ValidatorManager validatorManager,
        long transitionBlock,
        IEthereumEcdsa ecdsa,
        ILogManager logManager,
        long hardeningBlock = long.MaxValue,
        ulong blockPeriod = 0,
        ITimestamper? timestamper = null)
    {
        _hardeningBlock = hardeningBlock;
        _blockPeriod = blockPeriod;
        _timestamper = timestamper ?? Timestamper.Default;
        _baseValidator = baseValidator ?? throw new ArgumentNullException(nameof(baseValidator));
        _validatorManager = validatorManager ?? throw new ArgumentNullException(nameof(validatorManager));
        _transitionBlock = transitionBlock;
        _ecdsa = ecdsa ?? throw new ArgumentNullException(nameof(ecdsa));
        _logger = logManager?.GetClassLogger() ?? throw new ArgumentNullException(nameof(logManager));
    }

    /// <summary>
    /// Set the state reader so the seal validator can sync validators from the
    /// staking contract using the parent block's state root when validating blocks.
    /// </summary>
    public void SetStateReader(IStateReader stateReader) => _stateReader = stateReader;

    public bool ValidateParams(BlockHeader parent, BlockHeader header, bool isUncle = false)
    {
        // ALWAYS recover the signer from the seal and set header.Author —
        // even for pre-transition blocks. Without this, downstream nodes
        // computing gas-fee distribution use header.GasBeneficiary (which is
        // `Author ?? Beneficiary`); on the producer Author is set to the
        // sealer (admin) but on the receiving node Author stays null, so
        // GasBeneficiary falls back to Beneficiary (0x0). The producer
        // credits gas fees to admin while the receiver credits 0x0 → state
        // roots diverge and the receiver rejects every block that contains
        // a transaction. Always recovering the signer fixes the asymmetry.
        if (header.ExtraData != null
            && header.ExtraData.Length >= PoSSealer.ExtraVanityLength + PoSSealer.ExtraSealLength
            && header.Author is null)
        {
            Address recoveredSigner = RecoverSigner(header);
            if (recoveredSigner is not null) header.Author = recoveredSigner;
        }

        if (header.Number < _transitionBlock)
        {
            return _baseValidator.ValidateParams(parent, header, isUncle);
        }

        // v7.1.5: probe whether the parent state is reachable. During initial
        // sync of an operator that joined post-transition, parent.StateRoot
        // points at a block we haven't downloaded yet — the staking contract
        // storage can't be read. In that case, defer authorization checks:
        // accept the block (chain order is enforced by RLP/parent-hash, the
        // peer chain is the source of truth) and the staking contract will
        // be re-synced once we catch up.
        //
        // v7.1.8: HasStateForRoot can return true even when the staking
        // contract's storage isn't yet usable at that state root (state trie
        // may be partially loaded during FullSync, or the parent block was
        // downloaded but its post-state hasn't been computed yet). In that
        // case SyncValidatorsFromContract returns false and the validator set
        // remains empty — `IsValidator` then rejects every block and the
        // operator is permanently stuck. Treat "state probe says yes but
        // validator-set sync produced no validators" the same as "state not
        // available": defer authorization, accept the block (peer chain is
        // authoritative during initial sync), let the chain catch up.
        bool stateAvailable = false;
        bool validatorsReady = false;
        if (_stateReader is not null && parent?.StateRoot is not null)
        {
            try { stateAvailable = _stateReader.HasStateForRoot(parent.StateRoot); }
            catch { stateAvailable = false; }
            if (stateAvailable)
            {
                try
                {
                    validatorsReady = _validatorManager.SyncValidatorsFromContract(_stateReader, parent.StateRoot);
                }
                catch { validatorsReady = false; }
            }
        }

        // Structural checks always run (cheap, no state needed).
        if (header.UnclesHash != Keccak.OfAnEmptySequenceRlp)
        {
            if (_logger.IsWarn) _logger.Warn($"PoS: Invalid uncles hash at block {header.Number} - no uncles in PoS");
            return false;
        }
        if (header.ExtraData.Length < PoSSealer.ExtraVanityLength + PoSSealer.ExtraSealLength)
        {
            if (_logger.IsWarn) _logger.Warn($"PoS: Invalid extra data length at block {header.Number}");
            return false;
        }
        if (header.MixHash != Keccak.Zero)
        {
            if (_logger.IsWarn) _logger.Warn($"PoS: Invalid mix hash at block {header.Number} - should be zero");
            return false;
        }

        Address signer = RecoverSigner(header);
        if (signer is null)
        {
            if (_logger.IsWarn) _logger.Warn($"PoS: Could not recover signer at block {header.Number}");
            return false;
        }
        header.Author = signer;

        if (!PassesHardenedHeaderRules(parent, header))
        {
            return false;
        }

        if (header.Number >= _hardeningBlock && stateAvailable)
        {
            // The set at this header's own parent state, read locally. The shared cached
            // set can belong to another height while headers are validated in parallel.
            List<Address>? validatorsAtParent = ReadValidators(parent.StateRoot!);
            if (validatorsAtParent is not null)
            {
                string? error = CheckAuthority(parent, header, signer, validatorsAtParent);
                if (error is not null && _logger.IsWarn) _logger.Warn(error);
                return error is null;
            }
        }

        if (!stateAvailable || !validatorsReady)
        {
            // Initial-sync path: trust the chain order. The block's seal was
            // recovered, structure checks passed, parent-hash chain is intact
            // (enforced by Nethermind's BlockTree before us). Once we reach
            // a block whose parent state is local AND the staking contract
            // storage is readable at that state, full authorization +
            // round-robin validation kick back in.
            //
            // v7.1.8: also defer when state is reportedly available but the
            // validator-set sync produced 0 validators. Without this branch,
            // an operator whose local chain is mid-FullSync sees the empty
            // staked set, prints the "validator set is EMPTY" warn for every
            // header the peer announces, and rejects them all — chain stays
            // pinned forever at the height it was at when sync started.
            if (_logger.IsTrace) _logger.Trace($"PoS: parent state not yet usable at block {header.Number} (signer {signer}, stateAvail={stateAvailable}, validatorsReady={validatorsReady}); deferring authorization until sync catches up");
            return parent is null || header.Timestamp > parent.Timestamp;
        }

        // From here on: state is available, do full authorization.
        if (!_validatorManager.IsValidator(signer, header.Number, _transitionBlock))
        {
            if (_logger.IsWarn) _logger.Warn($"PoS: Signer {signer} is not an authorized validator at block {header.Number}");
            return false;
        }

        // v7.1.0 (audit N-C5): round-robin proposer enforcement.
        try
        {
            Address expected = _validatorManager.GetProposer(header.Number, _transitionBlock);
            if (header.Number >= _hardeningBlock)
            {
                UInt256 expectedDifficulty = signer == expected ? PoSBlockProducer.DifficultyInTurn : PoSBlockProducer.DifficultyNoTurn;
                if (header.Difficulty != expectedDifficulty)
                {
                    if (_logger.IsWarn) _logger.Warn($"PoS: Difficulty {header.Difficulty} of block {header.Number} does not match signer's turn (expected {expectedDifficulty})");
                    return false;
                }
            }
            if (signer != expected)
            {
                if (parent is not null && (long)(header.Timestamp - parent.Timestamp) < (long)OutOfTurnBackoffSeconds)
                {
                    if (_logger.IsWarn) _logger.Warn($"PoS: Out-of-turn signer {signer} (expected {expected}) before backoff window at block {header.Number}");
                    return false;
                }
                if (_logger.IsInfo) _logger.Info($"PoS: Accepting out-of-turn block from {signer} (expected {expected}) after backoff at block {header.Number}");
            }
        }
        catch (InvalidOperationException ex)
        {
            if (_logger.IsWarn) _logger.Warn($"PoS: Cannot validate proposer at block {header.Number}: {ex.Message}");
            return false;
        }

        // Validate timestamp
        if (parent is not null && header.Timestamp <= parent.Timestamp)
        {
            if (_logger.IsWarn) _logger.Warn($"PoS: Block timestamp {header.Timestamp} must be greater than parent {parent.Timestamp}");
            return false;
        }

        return true;
    }

    /// <summary>
    /// Header rules that need no state, in force from the hardening block. Difficulty
    /// is what fork choice sums, so an unbounded value would let one validator outweigh
    /// the whole chain; a far-future timestamp would stop every producer until that time.
    /// </summary>
    private bool PassesHardenedHeaderRules(BlockHeader? parent, BlockHeader header)
    {
        if (header.Number < _hardeningBlock)
        {
            return true;
        }

        if (header.Difficulty != PoSBlockProducer.DifficultyInTurn && header.Difficulty != PoSBlockProducer.DifficultyNoTurn)
        {
            if (_logger.IsWarn) _logger.Warn($"PoS: Invalid difficulty {header.Difficulty} at block {header.Number}");
            return false;
        }

        if (parent is not null && header.Timestamp < parent.Timestamp + _blockPeriod)
        {
            if (_logger.IsWarn) _logger.Warn($"PoS: Block {header.Number} is closer than {_blockPeriod}s to its parent");
            return false;
        }

        ulong now = _timestamper.UnixTime.Seconds;
        if (header.Timestamp > now + MaxFutureSeconds)
        {
            if (_logger.IsWarn) _logger.Warn($"PoS: Block {header.Number} timestamp {header.Timestamp} is too far ahead of local time {now}");
            return false;
        }

        return true;
    }

    /// <summary>
    /// Signer check made just before a block is executed. Header validation during
    /// sync runs ahead of execution and has to defer it because the parent state does
    /// not exist yet; here it does. Returns an error, or null when the block may run
    /// or the set can't be read at this state root.
    /// </summary>
    public string? CheckSignerAtProcessing(BlockHeader? parent, BlockHeader header)
    {
        if (header.Number < _hardeningBlock || header.Number < _transitionBlock
            || parent?.StateRoot is null || _stateReader is null)
        {
            return null;
        }

        List<Address>? validators = _stateReader.HasStateForRoot(parent.StateRoot) ? ReadValidators(parent.StateRoot) : null;
        if (validators is null)
        {
            return null;
        }

        Address? signer = RecoverSigner(header);
        return signer is null ? $"PoS: no signer recovered for block {header.Number}" : CheckAuthority(parent, header, signer, validators);
    }

    private List<Address>? ReadValidators(Hash256 stateRoot)
    {
        try
        {
            return _stateReader is not null ? _validatorManager.ReadValidatorsFromContract(_stateReader, stateRoot) : null;
        }
        catch (Exception ex)
        {
            if (_logger.IsDebug) _logger.Debug($"PoS: Could not read validators at {stateRoot}: {ex.Message}");
            return null;
        }
    }

    // The rules for who may seal this block, against the validator set at its parent state.
    private static string? CheckAuthority(BlockHeader parent, BlockHeader header, Address signer, List<Address> validators)
    {
        if (!validators.Contains(signer))
        {
            return $"PoS: signer {signer} is not an authorized validator at block {header.Number}";
        }

        Address expected = validators[(int)(header.Number % validators.Count)];
        if (signer != expected && header.Timestamp - parent.Timestamp < OutOfTurnBackoffSeconds)
        {
            return $"PoS: out-of-turn signer {signer} before the backoff window at block {header.Number}";
        }

        UInt256 expectedDifficulty = signer == expected ? PoSBlockProducer.DifficultyInTurn : PoSBlockProducer.DifficultyNoTurn;
        return header.Difficulty == expectedDifficulty ? null : $"PoS: difficulty {header.Difficulty} of block {header.Number} does not match the signer's turn";
    }

    public bool ValidateSeal(BlockHeader header, bool force)
    {
        // Same reason as ValidateParams: recover signer for ALL blocks so
        // GasBeneficiary agrees across producer and receiver.
        if (header.ExtraData != null
            && header.ExtraData.Length >= PoSSealer.ExtraVanityLength + PoSSealer.ExtraSealLength
            && header.Author is null)
        {
            Address recoveredSigner = RecoverSigner(header);
            if (recoveredSigner is not null) header.Author = recoveredSigner;
        }

        if (header.Number < _transitionBlock)
        {
            return _baseValidator.ValidateSeal(header, force);
        }

        Address signer = RecoverSigner(header);
        if (signer is null)
        {
            if (_logger.IsWarn) _logger.Warn($"PoS: Cannot validate seal - no signer recovered at block {header.Number}");
            return false;
        }

        header.Author = signer;
        // v7.1.0 (audit N-I2): authorization MUST also be enforced here. Some
        // engine code paths invoke ValidateSeal without ValidateParams; without
        // this check, an attacker who recovers any valid ECDSA signature gets
        // their block accepted on those code paths.
        //
        // v7.1.8: when the validator set is empty (operator still mid-sync,
        // staking contract storage not yet readable at the relevant state
        // root), defer the authorization check. ValidateParams runs on the
        // import path with parent state in hand and will enforce auth fully
        // once sync catches up. Returning false here would permanently pin
        // an operator that joined post-transition.
        var validatorsNow = _validatorManager.GetValidators(header.Number, _transitionBlock);
        if (validatorsNow.Count == 0)
        {
            if (_logger.IsTrace) _logger.Trace($"PoS: ValidateSeal deferred at block {header.Number} (signer {signer}) — validator set not yet synced");
            return true;
        }
        if (!validatorsNow.Contains(signer))
        {
            // The cached set follows the last validated parent, so while a node catches up it
            // can miss a validator that joined after the local head. From the hardening block
            // the signer is checked from this header's own parent state before it executes.
            if (header.Number >= _hardeningBlock)
            {
                if (_logger.IsTrace) _logger.Trace($"PoS: ValidateSeal deferred at block {header.Number} (signer {signer}) to the pre-execution check");
                return true;
            }
            if (_logger.IsWarn) _logger.Warn($"PoS: Seal signer {signer} is NOT an authorized validator at block {header.Number}");
            return false;
        }
        return true;
    }

    private Address RecoverSigner(BlockHeader header)
    {
        if (header.ExtraData.Length < PoSSealer.ExtraVanityLength + PoSSealer.ExtraSealLength)
            return null;

        // Extract signature from ExtraData
        int sealStart = header.ExtraData.Length - PoSSealer.ExtraSealLength;
        byte[] signatureBytes = new byte[65];
        Array.Copy(header.ExtraData, sealStart, signatureBytes, 0, 65);

        // Normalize V: Nethermind Signature(byte[65]) expects V >= 27 (Ethereum convention)
        if (signatureBytes[64] < 27)
            signatureBytes[64] += 27;

        // Calculate the header hash without the seal
        Hash256 headerHash = PoSSealer.CalculateHeaderHashForSigning(header);

        try
        {
            Signature signature = new(signatureBytes);
            return _ecdsa.RecoverAddress(signature, headerHash);
        }
        catch (Exception ex)
        {
            if (_logger.IsDebug) _logger.Debug($"PoS: Failed to recover signer: {ex.Message}");
            return null;
        }
    }
}
