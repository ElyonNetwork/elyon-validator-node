// SPDX-License-Identifier: LGPL-3.0-only
//
// RelayerAttestationBus — cross-layer event bus for v7.4.0 attestation gossip.
//
// `Nethermind.Network` (where protocol handlers live) doesn't reference
// `Nethermind.Consensus.PoS` (where the attestation pool lives). The bus
// is a small set of process-wide events in `Nethermind.Network` that both
// sides hook into:
//
//   * Pool (Consensus.PoS) subscribes to InboundFromPeer to store
//     attestations received from peers.
//   * Pool raises OutboundLocal when a local attestation is added
//     (via JSON-RPC from the dashboard).
//   * Eth68ProtocolHandler instances subscribe to OutboundLocal so
//     each peer-bound handler forwards the attestation to its peer.
//   * Handlers raise InboundFromPeer when they receive a
//     UnpRelayerAttestationMessage from their peer.
//
// Loop prevention: attestations that came in via InboundFromPeer are
// NOT re-fired through OutboundLocal — only attestations originating
// from this node (local RPC) trigger outbound broadcast. The pool
// distinguishes these via AddLocal vs AddRemote APIs.

using System;

namespace Nethermind.Network;

public static class RelayerAttestationBus
{
    /// <summary>
    /// Fired when a local attestation should be broadcast to all peers.
    /// Each Eth68ProtocolHandler subscribes; on fire, every peer-bound
    /// handler sends the message to its peer.
    /// </summary>
    public static event Action<byte[]>? OutboundLocal;

    /// <summary>
    /// Fired when a handler receives a UnpRelayerAttestation message
    /// from its peer. The pool subscribes to store these.
    /// </summary>
    public static event Action<byte[]>? InboundFromPeer;

    public static void RaiseOutbound(byte[] entry) => OutboundLocal?.Invoke(entry);
    public static void RaiseInbound(byte[] entry) => InboundFromPeer?.Invoke(entry);
}
