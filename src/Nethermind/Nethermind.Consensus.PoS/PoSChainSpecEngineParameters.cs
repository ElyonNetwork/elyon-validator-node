// SPDX-FileCopyrightText: 2024 Demerzel Solutions Limited
// SPDX-License-Identifier: LGPL-3.0-only

using Nethermind.Int256;
using Nethermind.Specs.ChainSpecStyle;

namespace Nethermind.Consensus.PoS;

public class PoSChainSpecEngineParameters : IChainSpecEngineParameters
{
    public string? EngineName => SealEngineType;
    public string? SealEngineType => Core.SealEngineType.PoS;
    public ulong Period { get; set; } = 15;
    public ulong Epoch { get; set; } = 30000;
    public long TransitionBlock { get; set; }
    public UInt256 Reward { get; set; } = new(2_000_000_000_000_000_000); // 2 ETH

    /// <summary>
    /// v7.2.2 — APOSPointer contract address baked into chainspec, the canonical
    /// "first link" of the APOS trust chain. Operators receive admin's chainspec
    /// byte-identical via /api/wizard/bootstrap, so all nodes resolve the pointer
    /// from this same field — eliminating any per-node config drift that could
    /// fork the chain on fee-distribution lookups.
    ///
    /// Stored as a hex string (e.g. "0xabcd…1234") in chainspec JSON:
    ///   engine.pos.params.aposPointer
    /// Empty/null until APOSPointer is deployed; chainspec is updated post-
    /// deploy and operators must refresh from admin's bootstrap to pick up
    /// the new value before the chain processes APOS-bearing blocks.
    /// </summary>
    public string? AposPointer { get; set; }

    /// <summary>
    /// v7.3.0 — Block number at which Layer 2 switches from equal-split node
    /// share (v7.2.x) to relayer-attribution. From this block onward, the L2
    /// hook reads relayer attestations from block.ExtraData and credits 100%
    /// of the node-share to the attested relayer (the RPC that first received
    /// the tx). Txs without an attestation in the block fall back to the
    /// equal-split behavior to preserve backwards compatibility during the
    /// rollout window.
    ///
    /// If null or zero, relayer attribution is disabled and v7.2.x equal-split
    /// applies indefinitely.
    /// </summary>
    public long? RelayerAttributionBlock { get; set; }

    /// <summary>
    /// v10.0 — Block number from which the stricter header rules apply: in-turn
    /// difficulty, minimum spacing between blocks, a bound on future timestamps
    /// and a signer check at processing time. Consensus-relevant: every validator
    /// must run a build with these rules before the chain reaches this block.
    /// If null or zero the rules are off and older blocks replay unchanged.
    /// </summary>
    public long? HardeningBlock { get; set; }
}
