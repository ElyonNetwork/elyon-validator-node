// SPDX-FileCopyrightText: 2024 Demerzel Solutions Limited
// SPDX-License-Identifier: LGPL-3.0-only

namespace Nethermind.Consensus.PoS;

public class PoSConfig : IPoSConfig
{
    public bool Enabled { get; set; }
    public long TransitionBlock { get; set; }
    public ulong BlockPeriod { get; set; } = 15;
    public string StakingContractAddress { get; set; } = string.Empty;
    // v7.1.0 (audit M1 / N-I1): default block reward = 0.
    public string BlockReward { get; set; } = "0x0";
}
