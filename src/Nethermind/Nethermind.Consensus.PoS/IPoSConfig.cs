// SPDX-FileCopyrightText: 2024 Demerzel Solutions Limited
// SPDX-License-Identifier: LGPL-3.0-only

using Nethermind.Config;

namespace Nethermind.Consensus.PoS;

public interface IPoSConfig : IConfig
{
    [ConfigItem(Description = "Whether PoS consensus is enabled", DefaultValue = "false")]
    bool Enabled { get; set; }

    [ConfigItem(Description = "Block number at which to transition from PoA to PoS. 0 means PoS from genesis.", DefaultValue = "0")]
    long TransitionBlock { get; set; }

    [ConfigItem(Description = "Block period in seconds for PoS phase", DefaultValue = "15")]
    ulong BlockPeriod { get; set; }

    [ConfigItem(Description = "Address of the staking contract", DefaultValue = "")]
    string StakingContractAddress { get; set; }

    // v7.1.0 (audit M1 / N-I1): default block reward = 0. Pre-transition
    // (PoA) blocks no longer mint UNP from thin air to whoever recovered
    // the signature. Operators that need historical Clique compatibility
    // can override via chainspec.
    [ConfigItem(Description = "Block reward in wei (hex). Default 0 — no implicit minting.", DefaultValue = "0x0")]
    string BlockReward { get; set; }
}
