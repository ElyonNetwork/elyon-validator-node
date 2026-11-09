// SPDX-FileCopyrightText: 2022 Demerzel Solutions Limited
// SPDX-License-Identifier: LGPL-3.0-only

using Nethermind.Network.P2P.Subprotocols.Eth.V65;

namespace Nethermind.Network.P2P.Subprotocols.Eth.V68;

public static class Eth68MessageCode
{
    public const int NewPooledTransactionHashes = Eth65MessageCode.NewPooledTransactionHashes;

    /// <summary>
    /// v7.4.0 — UNP chain custom message: carries relayer-attribution
    /// attestations between peers so block producers credit the original
    /// RPC even when they didn't receive the tx directly. Code 0x20 is
    /// above all standard eth/68 packet codes; mainline Ethereum nodes
    /// would ignore unknown codes, but the UNP chain only runs patched
    /// Nethermind on both sides, so this works as a chain-private
    /// extension.
    /// </summary>
    public const int UnpRelayerAttestation = 0x20;
}
