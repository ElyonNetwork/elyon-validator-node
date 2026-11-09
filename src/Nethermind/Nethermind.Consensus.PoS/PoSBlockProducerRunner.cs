// SPDX-FileCopyrightText: 2024 Demerzel Solutions Limited
// SPDX-License-Identifier: LGPL-3.0-only

using System;
using System.Threading;
using System.Threading.Channels;
using System.Threading.Tasks;
using Nethermind.Blockchain;
using Nethermind.Core;
using Nethermind.Logging;

namespace Nethermind.Consensus.PoS;

/// <summary>
/// Runs the PoS block producer on a timer, producing blocks at regular intervals.
/// Similar to Clique's block producer runner but with PoS-specific timing logic.
/// </summary>
public class PoSBlockProducerRunner : IBlockProducerRunner, IDisposable
{
    private readonly IBlockTree _blockTree;
    private readonly ITimestamper _timestamper;
    private readonly IBlockProducer _blockProducer;
    private readonly ulong _blockPeriod;
    private readonly ILogger _logger;

    private readonly CancellationTokenSource _cancellationTokenSource = new();
    private readonly System.Timers.Timer _timer = new();
    private DateTime _lastProducedBlock;
    private Task? _producerTask;

    private readonly Channel<Block> _signalsQueue = Channel.CreateUnbounded<Block>();

    public PoSBlockProducerRunner(
        IBlockTree blockTree,
        ITimestamper timestamper,
        IBlockProducer blockProducer,
        ulong blockPeriod,
        ILogManager logManager)
    {
        _blockTree = blockTree ?? throw new ArgumentNullException(nameof(blockTree));
        _timestamper = timestamper ?? throw new ArgumentNullException(nameof(timestamper));
        _blockProducer = blockProducer ?? throw new ArgumentNullException(nameof(blockProducer));
        _blockPeriod = blockPeriod;
        _logger = logManager?.GetClassLogger() ?? throw new ArgumentNullException(nameof(logManager));

        _timer.AutoReset = false;
        _timer.Elapsed += TimerOnElapsed;
        _timer.Interval = 100;
    }

    private void TimerOnElapsed(object sender, System.Timers.ElapsedEventArgs e)
    {
        try
        {
            if (_blockTree.Head is null)
            {
                _timer.Enabled = true;
                return;
            }

            // Check if enough time has passed since the last block
            if (_blockTree.Head.Timestamp + _blockPeriod <= _timestamper.UnixTime.Seconds)
            {
                Block? headBlock = _blockTree.FindBlock(_blockTree.Head.Hash, BlockTreeLookupOptions.None);
                if (headBlock is not null)
                {
                    _signalsQueue.Writer.TryWrite(headBlock);
                }
            }

            _timer.Enabled = true;
        }
        catch (Exception ex)
        {
            if (_logger.IsError) _logger.Error("PoS block producer timer error", ex);
            _timer.Enabled = true;
        }
    }

    public void Start()
    {
        _blockTree.NewHeadBlock += BlockTreeOnNewHeadBlock;
        _producerTask = RunConsumeSignal();
        _timer.Start();
        _lastProducedBlock = DateTime.UtcNow;
        if (_logger.IsInfo) _logger.Info("PoS block producer started");
    }

    private void BlockTreeOnNewHeadBlock(object? sender, BlockEventArgs e)
    {
        // CRITICAL: only queue a new production signal if enough wall-clock
        // time has actually passed. Without this guard, producing block N
        // immediately re-triggers production of N+1 via the NewHeadBlock
        // event, ignoring the block period and racing the chain forward at
        // CPU speed. Each new block then has timestamp = parent+period (in
        // the future), and after a few minutes the chain ends up days ahead
        // of real time. With this guard, the periodic 100ms timer becomes
        // the sole pacing mechanism — it queues exactly when parent+period
        // <= now, which is the correct schedule.
        if (e.Block.Timestamp + _blockPeriod > _timestamper.UnixTime.Seconds)
        {
            return;
        }
        _signalsQueue.Writer.TryWrite(e.Block);
    }

    private Task RunConsumeSignal()
    {
        TaskCompletionSource tcs = new();

        Thread thread = new(() =>
        {
            try
            {
                ConsumeSignal().Wait();
                if (_logger.IsDebug) _logger.Debug("PoS block producer complete.");
            }
            catch (TaskCanceledException) { }
            catch (OperationCanceledException) { }
            catch (Exception ex)
            {
                if (_logger.IsError) _logger.Error("PoS block producer encountered an exception.", ex);
            }
            finally
            {
                tcs.SetResult();
            }
        })
        {
            IsBackground = true,
            Name = "PoS block producer",
            Priority = ThreadPriority.AboveNormal,
        };
        thread.Start();

        return tcs.Task;
    }

    private async Task ConsumeSignal()
    {
        await foreach (Block signal in _signalsQueue.Reader.ReadAllAsync(_cancellationTokenSource.Token))
        {
            Block parentBlock = signal;

            // Drain any queued signals, keeping only the latest
            while (_signalsQueue.Reader.TryRead(out Block? nextSignal))
            {
                if (parentBlock.Number <= nextSignal.Number)
                    parentBlock = nextSignal;
            }

            try
            {
                Block? block = await _blockProducer.BuildBlock(parentBlock?.Header, cancellationToken: CancellationToken.None);
                if (block is not null)
                {
                    _lastProducedBlock = DateTime.UtcNow;
                    if (_logger.IsInfo) _logger.Info($"PoS: Produced block {block.ToString(Block.Format.HashNumberDiffAndTx)}");
                    BlockProduced?.Invoke(this, new BlockEventArgs(block));
                }
            }
            catch (Exception ex)
            {
                if (_logger.IsError) _logger.Error($"PoS: Failed to produce block on top of {parentBlock}", ex);
            }
        }
    }

    public async Task StopAsync()
    {
        _blockTree.NewHeadBlock -= BlockTreeOnNewHeadBlock;
        _timer.Stop();
        _cancellationTokenSource.Cancel();
        await (_producerTask ?? Task.CompletedTask);
        _signalsQueue.Writer.TryComplete();
        if (_logger.IsInfo) _logger.Info("PoS block producer stopped");
    }

    public bool IsProducingBlocks(ulong? maxProducingInterval)
    {
        if (_producerTask is null || _producerTask.IsCompleted)
            return false;
        if (maxProducingInterval is not null)
            return _lastProducedBlock.AddSeconds(maxProducingInterval.Value) > DateTime.UtcNow;
        return true;
    }

    public event EventHandler<BlockEventArgs>? BlockProduced;

    public void Dispose()
    {
        _cancellationTokenSource?.Dispose();
        _timer?.Dispose();
        _signalsQueue.Writer.TryComplete();
        BlockProduced = null;
    }
}
