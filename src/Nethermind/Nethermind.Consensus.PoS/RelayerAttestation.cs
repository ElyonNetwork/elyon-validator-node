// SPDX-License-Identifier: LGPL-3.0-only
//
// RelayerAttestation — v7.3.0 Layer 2 Phase 1A.
//
// A signed claim by an RPC node that it was the first to receive a given tx.
// The block proposer collects attestations from its mempool's tx metadata,
// serializes them into block.ExtraData BEFORE the seal, and the L2 hook
// credits the attested relayer the full 10% node-share for that tx.
//
// WIRE FORMAT in block.ExtraData (placed before the 65-byte PoSSealer seal,
// so it's covered by the seal automatically):
//
//   [ MARKER "URELAY1" (7 bytes ASCII) ]
//   [ count (uint16 big-endian, 2 bytes) ]
//   [ for each attestation:
//       txHash    (32 bytes)
//       relayer   (20 bytes — address)
//       signature (65 bytes — r||s||v, V = 27/28)
//     = 117 bytes per attestation
//   ]
//
// Total = 9 + 117 × count bytes (plus the 65-byte seal trailer after this).
//
// SIGNATURE DOMAIN:
//   sig = ECDSA-sign(
//           keccak256("UNP-RELAY-V1" ‖ chainId(8 BE) ‖ txHash ‖ relayer),
//           relayer.privateKey
//         )
// The L2 hook RECOVERS the address from the signature and requires it to match
// the claimed relayer field. A mismatched signature → attestation invalid →
// node-share for that tx falls back to equal split.
//
// COMPATIBILITY:
//   * Pre-transition blocks (block.Number < relayerAttributionBlock): hook
//     ignores extraData entirely, equal-split as in v7.2.x.
//   * Post-transition blocks without the URELAY1 marker: equal-split fallback
//     per tx. Producer that has no attestation data in mempool falls back
//     naturally — no chain halt.
//   * Post-transition blocks WITH marker but invalid signatures: invalid
//     attestations are dropped per-tx (counted as if not present); valid ones
//     still credit relayers. Hook does NOT throw or halt the chain.

using System;
using Nethermind.Core;
using Nethermind.Core.Crypto;
using Nethermind.Crypto;

namespace Nethermind.Consensus.PoS;

public readonly struct RelayerAttestation
{
    public Hash256 TxHash { get; }
    public Address Relayer { get; }
    public byte[] Signature { get; } // 65 bytes: r||s||v

    public RelayerAttestation(Hash256 txHash, Address relayer, byte[] signature)
    {
        TxHash = txHash;
        Relayer = relayer;
        Signature = signature;
    }
}

public static class RelayerAttestationCodec
{
    public const int MarkerLength = 7;
    public const int CountLength = 2;
    public const int HashLength = 32;
    public const int AddressLength = 20;
    public const int SignatureLength = 65;
    public const int EntryLength = HashLength + AddressLength + SignatureLength; // 117

    // ASCII "URELAY1"
    public static readonly byte[] Marker = { 0x55, 0x52, 0x45, 0x4C, 0x41, 0x59, 0x31 };

    /// <summary>
    /// Extract the attestation region from extraData. ExtraData layout:
    ///   [ vanity (32) | optional epoch signers | attestation region | seal (65) ]
    /// The attestation region sits between the standard vanity/signers prefix
    /// and the seal. We scan for the URELAY1 marker rather than assume a
    /// fixed offset, because epoch blocks include a validator list of variable
    /// length between vanity and our attestation region.
    /// </summary>
    /// <param name="extraData">Block.Header.ExtraData.</param>
    /// <param name="sealLength">PoSSealer.ExtraSealLength (65).</param>
    /// <returns>The attestations, or empty array if no marker/invalid.</returns>
    public static RelayerAttestation[] Decode(byte[] extraData, int sealLength)
    {
        if (extraData is null) return Array.Empty<RelayerAttestation>();
        int sealStart = extraData.Length - sealLength;
        if (sealStart <= 0) return Array.Empty<RelayerAttestation>();
        // Need at least marker + count + (0 entries) for the region to be valid.
        int minRegionLen = MarkerLength + CountLength;
        if (sealStart < minRegionLen) return Array.Empty<RelayerAttestation>();

        // Scan from offset 0 up to sealStart - minRegionLen for the marker.
        // The marker "URELAY1" is 7 bytes; vanity is "PoS <version>" ASCII so
        // it cannot contain the bytes 'U'/'R'/'E'/'L'/'A'/'Y'/'1' in sequence
        // (the substring "URELAY1" is not in any client name we emit).
        int markerOffset = -1;
        for (int i = 0; i + minRegionLen <= sealStart; i++)
        {
            bool match = true;
            for (int j = 0; j < MarkerLength; j++)
            {
                if (extraData[i + j] != Marker[j]) { match = false; break; }
            }
            if (match) { markerOffset = i; break; }
        }
        if (markerOffset < 0) return Array.Empty<RelayerAttestation>();

        int count = (extraData[markerOffset + MarkerLength] << 8) | extraData[markerOffset + MarkerLength + 1];
        if (count == 0) return Array.Empty<RelayerAttestation>();
        // Sanity bound.
        if (count > 1000) return Array.Empty<RelayerAttestation>();

        // The attestation region must end exactly at sealStart.
        int expectedEnd = markerOffset + MarkerLength + CountLength + count * EntryLength;
        if (expectedEnd != sealStart) return Array.Empty<RelayerAttestation>();

        var result = new RelayerAttestation[count];
        int offset = markerOffset + MarkerLength + CountLength;
        for (int i = 0; i < count; i++)
        {
            byte[] hashBytes = new byte[HashLength];
            Array.Copy(extraData, offset, hashBytes, 0, HashLength);
            offset += HashLength;

            byte[] addrBytes = new byte[AddressLength];
            Array.Copy(extraData, offset, addrBytes, 0, AddressLength);
            offset += AddressLength;

            byte[] sig = new byte[SignatureLength];
            Array.Copy(extraData, offset, sig, 0, SignatureLength);
            offset += SignatureLength;

            result[i] = new RelayerAttestation(new Hash256(hashBytes), new Address(addrBytes), sig);
        }
        return result;
    }

    /// <summary>
    /// Encode an attestations list into the prefix that goes BEFORE the seal
    /// in extraData. The seal is appended by PoSSealer afterwards.
    /// </summary>
    public static byte[] EncodePrefix(RelayerAttestation[] attestations)
    {
        if (attestations is null || attestations.Length == 0) return Array.Empty<byte>();
        int count = attestations.Length;
        byte[] buf = new byte[MarkerLength + CountLength + count * EntryLength];
        Buffer.BlockCopy(Marker, 0, buf, 0, MarkerLength);
        buf[MarkerLength] = (byte)((count >> 8) & 0xFF);
        buf[MarkerLength + 1] = (byte)(count & 0xFF);
        int offset = MarkerLength + CountLength;
        foreach (var att in attestations)
        {
            Buffer.BlockCopy(att.TxHash.Bytes.ToArray(), 0, buf, offset, HashLength);
            offset += HashLength;
            Buffer.BlockCopy(att.Relayer.Bytes, 0, buf, offset, AddressLength);
            offset += AddressLength;
            Buffer.BlockCopy(att.Signature, 0, buf, offset, SignatureLength);
            offset += SignatureLength;
        }
        return buf;
    }

    /// <summary>
    /// Compute the digest the relayer must have signed. The chainId binds the
    /// signature to one chain (prevents replay across forks); the txHash binds
    /// it to one specific tx; the relayer address binds it to one specific RPC.
    /// </summary>
    public static byte[] ComputeSigningDigest(ulong chainId, Hash256 txHash, Address relayer)
    {
        // domain string "UNP-RELAY-V1" (12 bytes) + chainId(8 BE) + txHash(32) + relayer(20) = 72
        byte[] domain = System.Text.Encoding.ASCII.GetBytes("UNP-RELAY-V1");
        byte[] buf = new byte[domain.Length + 8 + HashLength + AddressLength];
        int o = 0;
        Buffer.BlockCopy(domain, 0, buf, o, domain.Length); o += domain.Length;
        // chainId big-endian 8 bytes
        for (int i = 7; i >= 0; i--) { buf[o + i] = (byte)(chainId & 0xFF); chainId >>= 8; }
        o += 8;
        Buffer.BlockCopy(txHash.Bytes.ToArray(), 0, buf, o, HashLength); o += HashLength;
        Buffer.BlockCopy(relayer.Bytes, 0, buf, o, AddressLength);
        Hash256 digest = Keccak.Compute(buf);
        return digest.Bytes.ToArray();
    }

    /// <summary>
    /// Verify an attestation: recover the signer from the signature; require
    /// it to equal the claimed relayer field. Returns true iff the attestation
    /// is genuine for the given (chainId, txHash, relayer) tuple.
    /// </summary>
    public static bool Verify(RelayerAttestation att, ulong chainId, IEthereumEcdsa ecdsa)
    {
        if (att.Signature is null || att.Signature.Length != SignatureLength) return false;
        byte[] digest = ComputeSigningDigest(chainId, att.TxHash, att.Relayer);
        try
        {
            // V is the LAST byte (27/28); pull r/s as the first 64.
            byte v = att.Signature[64];
            byte[] r = new byte[32];
            byte[] s = new byte[32];
            Array.Copy(att.Signature, 0, r, 0, 32);
            Array.Copy(att.Signature, 32, s, 0, 32);
            Signature signature = new(r, s, v);
            Address? recovered = ecdsa.RecoverAddress(signature, new Hash256(digest));
            return recovered is not null && recovered == att.Relayer;
        }
        catch { return false; }
    }
}
