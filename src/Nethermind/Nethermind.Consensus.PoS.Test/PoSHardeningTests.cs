// SPDX-License-Identifier: LGPL-3.0-only
#nullable enable

using System;
using System.Collections.Generic;
using System.Linq;
using FluentAssertions;
using Nethermind.Blockchain;
using Nethermind.Consensus;
using Nethermind.Core;
using Nethermind.Core.Crypto;
using Nethermind.Crypto;
using Nethermind.Int256;
using Nethermind.Logging;
using Nethermind.State;
using Nethermind.Trie;
using NUnit.Framework;

namespace Nethermind.Consensus.PoS.Test;

[TestFixture]
public class PoSHardeningTests
{
    private const long Transition = 5;
    private const long Hardening = 100;
    private const ulong Period = 2;
    private const ulong ParentTime = 1_000_000;

    private static readonly EthereumEcdsa Ecdsa = new(55452773);
    private static readonly PrivateKey KeyA = new("010102030405060708090a0b0c0d0e0f000102030405060708090a0b0c0d0e0f");
    private static readonly PrivateKey KeyB = new("020102030405060708090a0b0c0d0e0f000102030405060708090a0b0c0d0e0f");
    private static readonly PrivateKey KeyC = new("030102030405060708090a0b0c0d0e0f000102030405060708090a0b0c0d0e0f");
    private static readonly PrivateKey Outsider = new("040102030405060708090a0b0c0d0e0f000102030405060708090a0b0c0d0e0f");
    private static readonly Address Staking = new("0x04250541308a1d1c633de3d435e361402505cf29");
    private static readonly Hash256 Root = Keccak.Compute("root");
    private static readonly PrivateKey[] Keys = { KeyA, KeyB, KeyC };
    private static readonly List<Address> Set = Keys.Select(k => k.Address).ToList();

    private sealed class FakeTimestamper(ulong seconds) : ITimestamper
    {
        public DateTime UtcNow { get; } = DateTimeOffset.FromUnixTimeSeconds((long)seconds).UtcDateTime;
    }

    private sealed class FakeState(IReadOnlyList<Address> validators, bool available = true) : IStateReader
    {
        private static readonly UInt256 Base = new(Keccak.Compute(new UInt256(3).ToBigEndian()).Bytes, isBigEndian: true);
        public bool TryGetAccount(Hash256 stateRoot, Address address, out AccountStruct account) { account = default; return true; }
        public ReadOnlySpan<byte> GetStorage(Hash256 stateRoot, Address address, in UInt256 index)
        {
            byte[] value = new byte[32];
            if (index == 3)
            {
                new UInt256((ulong)validators.Count).ToBigEndian(value);
            }
            else if (index >= Base && (index - Base) < (ulong)validators.Count)
            {
                validators[(int)(index - Base)].Bytes.CopyTo(value, 12);
            }
            return value;
        }
        public byte[]? GetCode(Hash256 codeHash) => null;
        public byte[]? GetCode(in ValueHash256 codeHash) => null;
        public void RunTreeVisitor<TCtx>(ITreeVisitor<TCtx> treeVisitor, Hash256 stateRoot, VisitingOptions? visitingOptions = null) where TCtx : struct, INodeContext<TCtx> { }
        public bool HasStateForRoot(Hash256 stateRoot) => available;
    }

    private static PoSSealValidator Validator(IReadOnlyList<Address>? set = null, ulong now = ParentTime + 2, bool stateAvailable = true)
    {
        ValidatorManager manager = new(LimboLogs.Instance) { StakingContractAddress = Staking };
        PoSSealValidator validator = new(NullSeal.Instance, manager, Transition, Ecdsa, LimboLogs.Instance, Hardening, Period, new FakeTimestamper(now));
        validator.SetStateReader(new FakeState(set ?? Set, stateAvailable));
        return validator;
    }

    private sealed class NullSeal : ISealValidator
    {
        public static readonly NullSeal Instance = new();
        public bool ValidateParams(BlockHeader parent, BlockHeader header, bool isUncle = false) => true;
        public bool ValidateSeal(BlockHeader header, bool force) => true;
    }

    private static BlockHeader Parent(long number) =>
        new(Keccak.Zero, Keccak.OfAnEmptySequenceRlp, Address.Zero, 2, number, 50_000_000, ParentTime, new byte[97]) { StateRoot = Root, Hash = Keccak.Compute("parent" + number) };

    private static BlockHeader Signed(BlockHeader parent, PrivateKey key, UInt256 difficulty, ulong? timestamp = null)
    {
        BlockHeader header = new(parent.Hash ?? Keccak.Compute("parent"), Keccak.OfAnEmptySequenceRlp, Address.Zero, difficulty, parent.Number + 1,
            50_000_000, timestamp ?? parent.Timestamp + Period, new byte[PoSSealer.ExtraVanityLength + PoSSealer.ExtraSealLength]) { MixHash = Keccak.Zero, StateRoot = Root };
        Signature signature = Ecdsa.Sign(key, PoSSealer.CalculateHeaderHashForSigning(header));
        byte[] seal = signature.Bytes.ToArray().Concat(new[] { (byte)signature.V }).ToArray();
        seal.CopyTo(header.ExtraData, PoSSealer.ExtraVanityLength);
        return header;
    }

    // Block 102's in-turn validator is index 102 % 3 == 0 (key A).
    private static BlockHeader ParentOf102 => Parent(101);

    private static PoSSealValidator ValidatorWithCachedSet(params Address[] cached)
    {
        ValidatorManager manager = new(LimboLogs.Instance) { StakingContractAddress = Staking };
        foreach (Address address in cached) manager.AddStakedValidator(address);
        return new PoSSealValidator(NullSeal.Instance, manager, Transition, Ecdsa, LimboLogs.Instance, Hardening, Period, new FakeTimestamper(ParentTime + 2));
    }

    [Test]
    public void ValidateSeal_defers_a_validator_newer_than_the_cached_set_from_the_hardening_block()
    {
        BlockHeader header = Signed(Parent(Hardening + 1), KeyB, PoSBlockProducer.DifficultyInTurn);
        ValidatorWithCachedSet(KeyA.Address).ValidateSeal(header, false).Should().BeTrue();
    }

    [Test]
    public void ValidateSeal_keeps_rejecting_an_unknown_signer_before_the_hardening_block()
    {
        BlockHeader header = Signed(Parent(Hardening - 10), KeyB, PoSBlockProducer.DifficultyInTurn);
        ValidatorWithCachedSet(KeyA.Address).ValidateSeal(header, false).Should().BeFalse();
    }

    [Test]
    public void In_turn_block_with_difficulty_two_is_accepted() =>
        Validator().ValidateParams(ParentOf102, Signed(ParentOf102, Keys[0], 2)).Should().BeTrue();

    [Test]
    public void In_turn_block_claiming_low_difficulty_is_rejected() =>
        Validator().ValidateParams(ParentOf102, Signed(ParentOf102, Keys[0], 1)).Should().BeFalse();

    [Test]
    public void Inflated_difficulty_is_rejected() =>
        Validator().ValidateParams(ParentOf102, Signed(ParentOf102, Keys[0], UInt256.MaxValue / 2)).Should().BeFalse();

    [Test]
    public void Out_of_turn_block_before_backoff_is_rejected() =>
        Validator(now: ParentTime + 9).ValidateParams(ParentOf102, Signed(ParentOf102, Keys[1], 1, ParentTime + 9)).Should().BeFalse();

    [Test]
    public void Out_of_turn_block_after_backoff_with_difficulty_one_is_accepted() =>
        Validator(now: ParentTime + 10).ValidateParams(ParentOf102, Signed(ParentOf102, Keys[1], 1, ParentTime + 10)).Should().BeTrue();

    [Test]
    public void Out_of_turn_block_claiming_in_turn_difficulty_is_rejected() =>
        Validator(now: ParentTime + 10).ValidateParams(ParentOf102, Signed(ParentOf102, Keys[1], 2, ParentTime + 10)).Should().BeFalse();

    [Test]
    public void Block_closer_than_the_period_is_rejected() =>
        Validator().ValidateParams(ParentOf102, Signed(ParentOf102, Keys[0], 2, ParentTime + 1)).Should().BeFalse();

    [Test]
    public void Far_future_timestamp_is_rejected()
    {
        BlockHeader header = Signed(ParentOf102, Keys[0], 2, ParentTime + 2 + PoSSealValidator.MaxFutureSeconds + 1);
        Validator(now: ParentTime + 2).ValidateParams(ParentOf102, header).Should().BeFalse();
    }

    [Test]
    public void Timestamp_within_the_allowed_drift_is_accepted()
    {
        BlockHeader header = Signed(ParentOf102, Keys[0], 2, ParentTime + 2 + PoSSealValidator.MaxFutureSeconds);
        Validator(now: ParentTime + 2).ValidateParams(ParentOf102, header).Should().BeTrue();
    }

    [Test]
    public void Signer_outside_the_set_is_rejected() =>
        Validator().ValidateParams(ParentOf102, Signed(ParentOf102, Outsider, 2)).Should().BeFalse();

    [Test]
    public void Before_the_hardening_block_old_blocks_still_validate()
    {
        BlockHeader parent = Parent(50);          // block 51: in-turn is index 0 (51 % 3)
        Validator().ValidateParams(parent, Signed(parent, Keys[0], 1, ParentTime + 1)).Should().BeTrue();
    }

    [Test]
    public void Deferred_path_still_applies_the_header_rules()
    {
        Validator(stateAvailable: false).ValidateParams(ParentOf102, Signed(ParentOf102, Outsider, 2)).Should().BeTrue();
        Validator(stateAvailable: false).ValidateParams(ParentOf102, Signed(ParentOf102, Outsider, 1000)).Should().BeFalse();
    }

    [Test]
    public void Processing_check_rejects_an_unauthorized_signer_that_header_validation_had_to_defer()
    {
        BlockHeader header = Signed(ParentOf102, Outsider, 2);
        Validator().CheckSignerAtProcessing(ParentOf102, header).Should().Contain("not an authorized validator");
    }

    [Test]
    public void Processing_check_accepts_the_in_turn_validator() =>
        Validator().CheckSignerAtProcessing(ParentOf102, Signed(ParentOf102, Keys[0], 2)).Should().BeNull();

    [Test]
    public void Processing_check_rejects_out_of_turn_before_backoff() =>
        Validator().CheckSignerAtProcessing(ParentOf102, Signed(ParentOf102, Keys[1], 1, ParentTime + 4)).Should().Contain("backoff");

    [Test]
    public void Processing_check_is_off_before_the_hardening_block()
    {
        BlockHeader parent = Parent(50);
        Validator().CheckSignerAtProcessing(parent, Signed(parent, Outsider, 2)).Should().BeNull();
    }

    [Test]
    public void Processing_check_passes_when_state_is_unavailable() =>
        Validator(stateAvailable: false).CheckSignerAtProcessing(ParentOf102, Signed(ParentOf102, Outsider, 2)).Should().BeNull();

    [Test]
    public void An_oversized_validator_array_keeps_the_set_readable()
    {
        List<Address> many = Enumerable.Range(1, 300).Select(i => new Address(Keccak.Compute(i.ToString()))).ToList();
        ValidatorManager manager = new(LimboLogs.Instance) { StakingContractAddress = Staking };
        List<Address>? read = manager.ReadValidatorsFromContract(new FakeState(many), Root);
        read.Should().HaveCount(ValidatorManager.MaxValidators);
        read!.Should().Equal(many.Take(ValidatorManager.MaxValidators));
    }

    [Test]
    public void An_empty_validator_array_reads_as_unavailable()
    {
        ValidatorManager manager = new(LimboLogs.Instance) { StakingContractAddress = Staking };
        manager.ReadValidatorsFromContract(new FakeState(Array.Empty<Address>()), Root).Should().BeNull();
    }

    [TestCase(0, ParentTime + 2, true, TestName = "In-turn validator produces at the period")]
    [TestCase(1, ParentTime + 2, false, TestName = "Next validator waits")]
    [TestCase(1, ParentTime + 9, false, TestName = "Next validator still waits just before the backoff")]
    [TestCase(1, ParentTime + 10, true, TestName = "Next validator steps in at the backoff")]
    [TestCase(2, ParentTime + 10, false, TestName = "Second backup waits one more period")]
    [TestCase(2, ParentTime + 12, true, TestName = "Second backup steps in after one more period")]
    public void Production_slots_open_in_order(int who, ulong now, bool open) =>
        PoSBlockProducer.IsSlotOpen(Set[who], Set, 102, ParentTime, now, Period).Should().Be(open);

    [Test]
    public void A_single_validator_is_never_held_back() =>
        PoSBlockProducer.IsSlotOpen(Set[0], Set.Take(1).ToList(), 102, ParentTime, ParentTime, Period).Should().BeTrue();

    [Test]
    public void A_non_validator_never_produces() =>
        PoSBlockProducer.IsSlotOpen(Staking, Set, 102, ParentTime, ParentTime + 1000, Period).Should().BeFalse();
}
