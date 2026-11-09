// SPDX-FileCopyrightText: 2024 Demerzel Solutions Limited
// SPDX-License-Identifier: LGPL-3.0-only

using Nethermind.Consensus.Rewards;
using Nethermind.Core;
using Nethermind.Evm.TransactionProcessing;
using Nethermind.Int256;

namespace Nethermind.Consensus.PoS;

/// <summary>
/// Calculates block rewards for PoS blocks.
///
/// POLICY:
///   * BEFORE transitionBlock: pay block reward (as configured in chainspec)
///     to the block's signer. This emulates Clique behaviour so that, when a
///     node has been synced from a foreign PoA chain, the historical blocks
///     re-execute to the SAME state root that the foreign chain produced
///     (which had Clique block rewards baked in). Without this, the synced
///     state diverges and the first PoS block produced after transition
///     fails state-root validation.
///   * AT/AFTER transitionBlock: NO block reward. PoS validators earn only
///     the transaction fees of the txs they include — those fees flow to the
///     block beneficiary automatically via the EVM, outside of this
///     calculator.
/// </summary>
public class PoSRewardCalculator : IRewardCalculator
{
    private readonly long _transitionBlock;
    private readonly UInt256 _blockReward;

    public PoSRewardCalculator(long transitionBlock, UInt256 blockReward)
    {
        _transitionBlock = transitionBlock;
        _blockReward = blockReward;
    }

    public BlockReward[] CalculateRewards(Block block)
    {
        // Post-transition (PoS): validators earn only tx fees, no block reward.
        if (block.Number >= _transitionBlock) return [];
        // Reward = 0 means no block reward even pre-transition.
        if (_blockReward.IsZero) return [];

        // Pre-transition (Clique-compatible PoA): pay reward to the block
        // signer. The signer is whichever of these is non-zero, in order:
        //   1. Header.Author (Clique seal-validator typically populates this
        //      after recovering signature)
        //   2. Header.Beneficiary (the coinbase field — set explicitly on
        //      blocks produced by our own PoSBlockProducer when Author isn't
        //      separately tracked)
        Address? recipient = null;
        if (block.Header.Author is not null && block.Header.Author != Address.Zero)
            recipient = block.Header.Author;
        else if (block.Header.Beneficiary is not null && block.Header.Beneficiary != Address.Zero)
            recipient = block.Header.Beneficiary;

        if (recipient is null) return [];
        return [new BlockReward(recipient, _blockReward, BlockRewardType.Block)];
    }
}

public class PoSRewardCalculatorSource : Rewards.IRewardCalculatorSource
{
    private readonly long _transitionBlock;
    private readonly UInt256 _blockReward;

    public PoSRewardCalculatorSource(long transitionBlock, UInt256 blockReward)
    {
        _transitionBlock = transitionBlock;
        _blockReward = blockReward;
    }

    public IRewardCalculator Get(ITransactionProcessor processor)
    {
        return new PoSRewardCalculator(_transitionBlock, _blockReward);
    }
}
