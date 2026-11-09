// SPDX-License-Identifier: LGPL-3.0-only

using DotNetty.Buffers;
using Nethermind.Core.Collections;
using Nethermind.Serialization.Rlp;

namespace Nethermind.Network.P2P.Subprotocols.Eth.V68.Messages
{
    public class UnpRelayerAttestationMessageSerializer
        : IZeroMessageSerializer<UnpRelayerAttestationMessage>
    {
        // Each inner attestation is exactly 117 bytes.
        private const int EntrySize = 117;

        public UnpRelayerAttestationMessage Deserialize(IByteBuffer byteBuffer)
        {
            NettyRlpStream rlpStream = new(byteBuffer);
            int end = rlpStream.Position + rlpStream.ReadSequenceLength();
            ArrayPoolList<byte[]> list = new(UnpRelayerAttestationMessage.MaxCount);
            // One pass, bounded by MaxCount: a message of many tiny entries must not
            // cost more than the valid entries it could carry.
            while (rlpStream.Position < end)
            {
                byte[] bytes = rlpStream.DecodeByteArray();
                if (bytes is null || bytes.Length != EntrySize)
                {
                    continue;
                }

                if (list.Count >= UnpRelayerAttestationMessage.MaxCount)
                {
                    list.Dispose();
                    throw new RlpException($"UnpRelayerAttestation: more than {UnpRelayerAttestationMessage.MaxCount} entries");
                }

                list.Add(bytes);
            }

            return new UnpRelayerAttestationMessage(list);
        }

        public void Serialize(IByteBuffer byteBuffer, UnpRelayerAttestationMessage message)
        {
            int innerLength = 0;
            foreach (byte[] entry in message.Attestations.AsSpan())
            {
                innerLength += Rlp.LengthOf(entry);
            }
            int totalSize = Rlp.LengthOfSequence(innerLength);

            byteBuffer.EnsureWritable(totalSize);
            NettyRlpStream rlpStream = new(byteBuffer);
            rlpStream.StartSequence(innerLength);
            foreach (byte[] entry in message.Attestations.AsSpan())
            {
                rlpStream.Encode(entry);
            }
        }
    }
}
