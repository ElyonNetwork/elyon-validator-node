// SPDX-FileCopyrightText: 2024 Demerzel Solutions Limited
// SPDX-License-Identifier: LGPL-3.0-only

using Nethermind.Core;

namespace Nethermind.Consensus.PoS;

/// <summary>
/// Gossip policy for PoS blocks.
/// Always allows block gossip (both pre and post transition).
/// </summary>
public class PoSGossipPolicy : IGossipPolicy
{
    public static readonly PoSGossipPolicy Instance = new();

    public bool CanGossipBlocks => true;

    public bool ShouldGossipBlock(BlockHeader header) => true;

    public bool ShouldDisconnectGossipingNodes => false;

    public bool ShouldDiscardBlocks => false;
}
