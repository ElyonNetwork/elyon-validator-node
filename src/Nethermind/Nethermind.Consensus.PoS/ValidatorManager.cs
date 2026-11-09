// SPDX-FileCopyrightText: 2024 Demerzel Solutions Limited
// SPDX-License-Identifier: LGPL-3.0-only

using System;
using System.Collections.Generic;
using System.Linq;
using Nethermind.Core;
using Nethermind.Core.Crypto;
using Nethermind.Int256;
using Nethermind.Logging;
using Nethermind.State;

namespace Nethermind.Consensus.PoS;

/// <summary>
/// Manages the set of active validators for PoS consensus.
/// Before the transition block, uses the initial signer set from genesis ExtraData.
/// After the transition block, reads the staked validator set from the on-chain staking contract.
/// </summary>
public class ValidatorManager
{
    private readonly ILogger _logger;
    private readonly List<Address> _genesisValidators = new();
    private readonly List<Address> _stakedValidators = new();
    private readonly object _lock = new();

    // v7.1.1 FIX: callback PoSPlugin registers so the validator can lazy-load
    // the staking contract address from wizard-config if it's still null at
    // validate time. Defeats the chicken-and-egg deadlock where blocks can't
    // land (validator set empty) so OnNewHeadBlock never fires (head never
    // updates) so the address never gets loaded.
    public System.Action? OnNeedReloadStakingAddress { get; set; }

    /// <summary>
    /// The address of the deployed staking contract. Set after deployment.
    /// v7.1.0 (audit N-C4): set-once. After the first non-null assignment,
    /// further writes are rejected with InvalidOperationException, so a
    /// compromised wizard-config or attacker-writable env can't swap the
    /// staking pointer mid-flight to attacker-controlled bytecode.
    /// </summary>
    private Address? _stakingContractAddress;
    public Address? StakingContractAddress
    {
        get => _stakingContractAddress;
        set
        {
            if (_stakingContractAddress is not null && value is not null && _stakingContractAddress != value)
            {
                throw new InvalidOperationException(
                    $"PoS: refusing to change StakingContractAddress (already {_stakingContractAddress}, attempt {value}).");
            }
            _stakingContractAddress = value;
        }
    }

    // Solidity storage layout for StakingContract.sol:
    //   slot 0: address admin
    //   slot 1: uint256 MIN_STAKE                    (was a constant before v1.5)
    //   slot 2: mapping(address => Validator) validators
    //   slot 3: address[] activeValidators (dynamic array)
    //     - slot 3 stores the array length
    //     - elements start at keccak256(bytes32(3))
    //
    // Pre-v1.5 layout had MIN_STAKE/UNSTAKE_DELAY as constants and the array
    // at slot 1. Newer deployments must use slot 3.
    private static readonly UInt256 ValidatorsArraySlot = 3;

    public const int MaxValidators = 256;

    public ValidatorManager(ILogManager logManager)
    {
        _logger = logManager?.GetClassLogger() ?? throw new ArgumentNullException(nameof(logManager));
    }

    public void SetGenesisValidators(IEnumerable<Address> validators)
    {
        lock (_lock)
        {
            _genesisValidators.Clear();
            _genesisValidators.AddRange(validators);
            if (_logger.IsInfo) _logger.Info($"PoS: Set {_genesisValidators.Count} genesis validators");
        }
    }

    public void AddStakedValidator(Address validator)
    {
        lock (_lock)
        {
            if (!_stakedValidators.Contains(validator))
            {
                _stakedValidators.Add(validator);
                if (_logger.IsInfo) _logger.Info($"PoS: Added staked validator {validator}");
            }
        }
    }

    public void RemoveStakedValidator(Address validator)
    {
        lock (_lock)
        {
            _stakedValidators.Remove(validator);
        }
    }

    /// <summary>
    /// Reads the active validators array directly from the staking contract's storage.
    /// This ensures all nodes agree on the same validator set by reading on-chain state.
    /// </summary>
    /// <param name="stateReader">State reader to access contract storage</param>
    /// <param name="stateRoot">The state root at which to read (typically parent block's state root)</param>
    /// <returns>True if validators were successfully synced from the contract</returns>
    public bool SyncValidatorsFromContract(IStateReader stateReader, Hash256 stateRoot)
    {
        List<Address>? contractValidators = ReadValidatorsFromContract(stateReader, stateRoot);
        if (contractValidators is null)
        {
            return false;
        }

        lock (_lock)
        {
            // Only update if the set has actually changed
            if (!_stakedValidators.SequenceEqual(contractValidators))
            {
                _stakedValidators.Clear();
                _stakedValidators.AddRange(contractValidators);
                if (_logger.IsInfo) _logger.Info($"PoS: Synced {contractValidators.Count} validators from staking contract: {string.Join(", ", contractValidators)}");
            }
        }
        return true;
    }

    /// <summary>
    /// Reads the active validator set at a state root without touching the shared
    /// cached set. Returns null when the contract or its storage can't be read.
    /// At most <see cref="MaxValidators"/> entries are used: an oversized array must
    /// not make the set unreadable, because an unreadable set defers authorization.
    /// </summary>
    public List<Address>? ReadValidatorsFromContract(IStateReader stateReader, Hash256 stateRoot)
    {
        if (StakingContractAddress is null)
        {
            if (_logger.IsTrace) _logger.Trace("PoS: No staking contract address set, skipping sync");
            return null;
        }

        try
        {
            // Check if the contract account exists
            if (!stateReader.TryGetAccount(stateRoot, StakingContractAddress, out var account))
            {
                if (_logger.IsTrace) _logger.Trace($"PoS: Staking contract {StakingContractAddress} not found at state root {stateRoot}");
                return null;
            }

            // Read the validators array length from slot 3
            ReadOnlySpan<byte> lengthBytes = stateReader.GetStorage(stateRoot, StakingContractAddress, in ValidatorsArraySlot);
            UInt256 arrayLength = new UInt256(lengthBytes, isBigEndian: true);

            if (arrayLength == 0)
            {
                if (_logger.IsTrace) _logger.Trace("PoS: Staking contract validators array is empty");
                return null;
            }

            if (arrayLength > MaxValidators)
            {
                if (_logger.IsWarn) _logger.Warn($"PoS: Staking contract lists {arrayLength} validators; using the first {MaxValidators}");
                arrayLength = MaxValidators;
            }

            // Compute the base storage slot for array elements: keccak256(bytes32(3))
            byte[] slotBytes = new byte[32];
            ValidatorsArraySlot.ToBigEndian(slotBytes);
            Hash256 baseHash = Keccak.Compute(slotBytes);
            UInt256 baseSlot = new UInt256(baseHash.Bytes, isBigEndian: true);

            List<Address> contractValidators = new();
            for (UInt256 i = 0; i < arrayLength; i++)
            {
                UInt256 elementSlot = baseSlot + i;
                ReadOnlySpan<byte> storageValue = stateReader.GetStorage(stateRoot, StakingContractAddress, in elementSlot);

                // Address is stored in the last 20 bytes of the 32-byte storage slot
                if (storageValue.Length >= 20)
                {
                    byte[] addrBytes = new byte[20];
                    // Storage value is big-endian 32 bytes, address in the last 20
                    int offset = storageValue.Length - 20;
                    storageValue.Slice(offset, 20).CopyTo(addrBytes);
                    Address addr = new Address(addrBytes);
                    if (addr != Address.Zero)
                    {
                        contractValidators.Add(addr);
                    }
                }
            }

            return contractValidators.Count > 0 ? contractValidators : null;
        }
        catch (Exception ex)
        {
            if (_logger.IsDebug) _logger.Debug($"PoS: Failed to sync validators from contract: {ex.Message}");
        }

        return null;
    }

    public IReadOnlyList<Address> GetValidators(long blockNumber, long transitionBlock)
    {
        // v7.1.1: if staked set is empty AND we don't yet know the staking
        // contract address, try to load it from wizard-config now (operator
        // case where the staking contract was deployed AFTER the operator
        // joined). Done OUTSIDE the lock to avoid deadlocking the callback.
        if (_stakingContractAddress is null && OnNeedReloadStakingAddress is not null)
        {
            try { OnNeedReloadStakingAddress.Invoke(); } catch { }
        }
        lock (_lock)
        {
            // v7.1.0 (audit N-C2): post-transition, an empty staked set is a
            // hard error — never silently fall back to genesis.
            if (blockNumber < transitionBlock)
            {
                return _genesisValidators.AsReadOnly();
            }
            if (_stakedValidators.Count == 0)
            {
                if (_logger.IsWarn) _logger.Warn(
                    $"PoS: post-transition (block {blockNumber}, transition {transitionBlock}) but staked validator set is EMPTY — refusing to fall back to genesis. Chain will halt until staking contract is populated.");
                return Array.Empty<Address>();
            }
            return _stakedValidators.AsReadOnly();
        }
    }

    /// <summary>
    /// Determines the expected block proposer using round-robin selection.
    /// </summary>
    public Address GetProposer(long blockNumber, long transitionBlock)
    {
        IReadOnlyList<Address> validators = GetValidators(blockNumber, transitionBlock);
        if (validators.Count == 0)
        {
            throw new InvalidOperationException("No validators available for block production");
        }

        int index = (int)(blockNumber % validators.Count);
        return validators[index];
    }

    /// <summary>
    /// Checks if the given address is an authorized validator for the given block.
    /// </summary>
    public bool IsValidator(Address address, long blockNumber, long transitionBlock)
    {
        IReadOnlyList<Address> validators = GetValidators(blockNumber, transitionBlock);
        return validators.Contains(address);
    }

    /// <summary>
    /// Extracts initial validators from signer bytes in genesis ExtraData.
    /// Format: 32-byte vanity + N*20-byte signers + 65-byte seal
    /// </summary>
    public static IEnumerable<Address> ExtractValidatorsFromExtraData(byte[] extraData)
    {
        const int vanityLength = 32;
        const int sealLength = 65;

        if (extraData.Length < vanityLength + sealLength)
            yield break;

        int signersLength = extraData.Length - vanityLength - sealLength;
        if (signersLength % Address.Size != 0)
            yield break;

        int signerCount = signersLength / Address.Size;
        for (int i = 0; i < signerCount; i++)
        {
            byte[] addressBytes = new byte[Address.Size];
            Array.Copy(extraData, vanityLength + i * Address.Size, addressBytes, 0, Address.Size);
            yield return new Address(addressBytes);
        }
    }
}
