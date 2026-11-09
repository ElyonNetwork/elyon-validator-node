// SPDX-License-Identifier: LGPL-3.0-only
//
// UnpRelayerAttestationMessage — v7.4.0 Phase 2 (UNP chain extension).
//
// Carries one or more relayer attestations between peers. Sent in the
// eth/68 subprotocol channel under packet code Eth68MessageCode.UnpRelayerAttestation.
// Other Ethereum clients won't recognise this code; the UNP chain runs
// only patched Nethermind binaries that DO recognise it, so handshake
// compatibility is preserved.
//
// Wire format (RLP):
//   [
//     [ txHash_1 (32B) | relayer_1 (20B) | sig_1 (65B) ],
//     [ txHash_2 (32B) | relayer_2 (20B) | sig_2 (65B) ],
//     ...
//   ]
// Each inner item is a flat byte string of exactly 117 bytes (the same
// binary format used by the file-based v7.3.x mechanism, so the wire
// format and the file format share a single canonical encoding).

using Nethermind.Core.Collections;
using Nethermind.Network.P2P.Messages;

namespace Nethermind.Network.P2P.Subprotocols.Eth.V68.Messages
{
    public class UnpRelayerAttestationMessage(IOwnedReadOnlyList<byte[]> attestations) : P2PMessage
    {
        public const int MaxCount = 512; // bounded per message; broadcaster batches

        public override int PacketType { get; } = Eth68MessageCode.UnpRelayerAttestation;
        public override string Protocol { get; } = "eth";

        public readonly IOwnedReadOnlyList<byte[]> Attestations = attestations;

        public override string ToString() => $"{nameof(UnpRelayerAttestationMessage)}({Attestations.Count})";

        public override void Dispose()
        {
            base.Dispose();
            Attestations.Dispose();
        }
    }
}
