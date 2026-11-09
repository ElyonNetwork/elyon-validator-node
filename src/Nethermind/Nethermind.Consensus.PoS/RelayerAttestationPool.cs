// SPDX-License-Identifier: LGPL-3.0-only
//
// RelayerAttestationPool — v7.4.0 Phase 2 (in-process pool + p2p sync).
//
// FLOW:
//   1. Dashboard's RPC proxy receives eth_sendRawTransaction.
//   2. Dashboard signs the relayer attestation and calls JSON-RPC
//      method `unp_pushAttestation(bytes)` on the local Nethermind.
//   3. The RPC handler calls RelayerAttestationPool.AddLocal which:
//        a. Verifies the signature.
//        b. Stores the attestation in process memory.
//        c. Fires RelayerAttestationBus.OutboundLocal — each Eth68
//           protocol handler is subscribed and sends an
//           UnpRelayerAttestationMessage to its peer.
//   4. Peers receive the message, fire RelayerAttestationBus.InboundFromPeer.
//      This pool is subscribed to that event and adds the attestation
//      (verifying signature; does NOT re-broadcast — first-seen wins).
//   5. PoSBlockProducer reads attestations from this pool when assembling
//      blocks (replacing the v7.3.x file-based path).
//
// VERIFICATION:
//   Both AddLocal and AddRemote verify the secp256k1 signature against
//   the canonical UNP-RELAY-V1 digest. Invalid entries are silently
//   dropped — the network can spam any garbage at us; we just won't
//   credit it.

using System;
using System.Collections.Concurrent;
using System.Threading;
using Nethermind.Core;
using Nethermind.Core.Crypto;
using Nethermind.Crypto;
using Nethermind.Network;

namespace Nethermind.Consensus.PoS;

public static class RelayerAttestationPool
{
    private const int EXPIRY_SECONDS = 3600;
    private const int MAX_ENTRIES = 100_000;
    private const int ENTRY_SIZE = 117;
    private const int HASH_LEN = 32;
    private const int ADDR_LEN = 20;
    private const int SIG_LEN = 65;

    private static readonly ConcurrentDictionary<Hash256, Entry> _entries = new();
    private static long _count;
    private static long _lastSweep = DateTimeOffset.UtcNow.ToUnixTimeSeconds();

    // Configured at plugin Init time — captures the chain ID + ECDSA recovery
    // helper so AddRemote can verify peer-supplied attestations.
    private static ulong _chainId;
    private static IEthereumEcdsa? _ecdsa;
    private static bool _wired;
    private static readonly object _wireLock = new();

    private readonly struct Entry
    {
        public Entry(RelayerAttestation attestation, long unixSec)
        {
            Attestation = attestation;
            AddedAt = unixSec;
        }
        public RelayerAttestation Attestation { get; }
        public long AddedAt { get; }
    }

    /// <summary>
    /// One-time wire-up: register the chainId + ECDSA, subscribe to the
    /// inbound bus event. Idempotent — safe to call from PoSPlugin.Init
    /// even if Init runs multiple times.
    /// </summary>
    public static void Wire(ulong chainId, IEthereumEcdsa ecdsa)
    {
        lock (_wireLock)
        {
            _chainId = chainId;
            _ecdsa = ecdsa;
            if (_wired) return;
            RelayerAttestationBus.InboundFromPeer += OnInboundFromPeer;
            _wired = true;
        }
    }

    /// <summary>
    /// Add a locally-originated attestation (from the dashboard via
    /// JSON-RPC). Verifies signature, stores it, AND broadcasts to all
    /// connected peers via the bus.
    /// </summary>
    public static bool AddLocal(byte[] entry)
    {
        if (!VerifyAndDecode(entry, out RelayerAttestation att)) return false;
        if (!TryAddInternal(att)) return false;
        // Fire-and-forget broadcast. Subscribers (one per peer) handle
        // the actual network send.
        try { RelayerAttestationBus.RaiseOutbound(entry); } catch { }
        return true;
    }

    /// <summary>
    /// Add a peer-sourced attestation (received via the eth/68 subprotocol).
    /// Verifies signature, stores. Does NOT re-broadcast.
    /// </summary>
    public static bool AddRemote(byte[] entry)
    {
        if (!VerifyAndDecode(entry, out RelayerAttestation att)) return false;
        return TryAddInternal(att);
    }

    private static void OnInboundFromPeer(byte[] entry) => AddRemote(entry);

    /// <summary>
    /// Look up an attestation by txHash. Returns null if absent.
    /// </summary>
    public static RelayerAttestation? TryGet(Hash256 txHash)
    {
        if (_entries.TryGetValue(txHash, out Entry e)) return e.Attestation;
        return null;
    }

    // ConcurrentDictionary.Count takes every lock in the dictionary, so a count is kept alongside it.
    public static int Count => (int)Interlocked.Read(ref _count);

    // ─── internals ────────────────────────────────────────────────────────

    private static bool VerifyAndDecode(byte[] entry, out RelayerAttestation att)
    {
        att = default;
        if (entry is null || entry.Length != ENTRY_SIZE) return false;
        if (_ecdsa is null) return false;
        byte[] hashBytes = new byte[HASH_LEN]; Array.Copy(entry, 0, hashBytes, 0, HASH_LEN);
        byte[] addrBytes = new byte[ADDR_LEN]; Array.Copy(entry, HASH_LEN, addrBytes, 0, ADDR_LEN);
        byte[] sigBytes  = new byte[SIG_LEN];  Array.Copy(entry, HASH_LEN + ADDR_LEN, sigBytes, 0, SIG_LEN);
        var candidate = new RelayerAttestation(new Hash256(hashBytes), new Address(addrBytes), sigBytes);
        if (!RelayerAttestationCodec.Verify(candidate, _chainId, _ecdsa)) return false;
        att = candidate;
        return true;
    }

    private static bool TryAddInternal(RelayerAttestation att)
    {
        long now = DateTimeOffset.UtcNow.ToUnixTimeSeconds();
        if (now - _lastSweep > 300)
        {
            _lastSweep = now;
            Sweep(now);
        }
        if (Interlocked.Read(ref _count) >= MAX_ENTRIES) return false;
        if (!_entries.TryAdd(att.TxHash, new Entry(att, now))) return false;
        Interlocked.Increment(ref _count);
        return true;
    }

    private static void Sweep(long now)
    {
        long cutoff = now - EXPIRY_SECONDS;
        foreach (var kv in _entries)
        {
            if (kv.Value.AddedAt < cutoff && _entries.TryRemove(kv.Key, out _))
            {
                Interlocked.Decrement(ref _count);
            }
        }
    }
}
