// SPDX-FileCopyrightText: 2024 Demerzel Solutions Limited
// SPDX-License-Identifier: LGPL-3.0-only

using System;
using System.IO;
using System.Linq;
using System.Threading.Tasks;
using Nethermind.Api;
using Nethermind.Api.Extensions;
using Nethermind.Blockchain;
using Nethermind.Blockchain.BeaconBlockRoot;
using Nethermind.Blockchain.Find;
using Nethermind.Blockchain.Blocks;
using Nethermind.Blockchain.Receipts;
using Nethermind.Config;
using Nethermind.Consensus.Comparers;
using Nethermind.Consensus.Processing;
using Nethermind.Consensus.Producers;
using Nethermind.Consensus.Rewards;
using Nethermind.Consensus.Transactions;
using Nethermind.Consensus.Withdrawals;
using Nethermind.Core;
using Nethermind.Core.Crypto;
using Nethermind.Evm.TransactionProcessing;
using Nethermind.Int256;
using Nethermind.Logging;
using Nethermind.Specs.ChainSpecStyle;
using Nethermind.State;

namespace Nethermind.Consensus.PoS;

/// <summary>
/// PoS Consensus Plugin for UNPChain.
/// Implements IConsensusPlugin to provide a complete PoS consensus engine that supports
/// live transition from PoA (Clique-like) to PoS at a configurable block number.
///
/// Before transition: Uses genesis validators from ExtraData (same as Clique)
/// After transition: Uses stake-weighted validator set
/// </summary>
public class PoSPlugin : IConsensusPlugin
{
    private readonly ChainSpec _chainSpec;
    private INethermindApi? _nethermindApi;
    private ValidatorManager? _validatorManager;
    private PoSSealer? _sealer;
    private IPoSConfig? _posConfig;
    private PoSBlockProducerRunner? _blockProducerRunner;
    private long _transitionBlock;
    private ulong _blockPeriod;
    private ulong _epoch;
    private UInt256 _blockReward;
    private ILogger _logger;
    private IStateReader? _stateReader;
    private System.IO.FileSystemWatcher? _attestationWatcher;
    private System.Threading.Timer? _attestationPollTimer;
    private readonly System.Collections.Concurrent.ConcurrentDictionary<string, byte> _handledAttestationFiles = new();

    public PoSPlugin(ChainSpec chainSpec)
    {
        _chainSpec = chainSpec;
    }

    /// <summary>
    /// v7.4.0 — watch /data/attestations for new files written by the
    /// dashboard. Each new file is a 117-byte attestation record; on
    /// arrival we feed it to RelayerAttestationPool.AddLocal which
    /// stores AND broadcasts to all currently-connected peers via
    /// the eth/68 UnpRelayerAttestation message.
    /// </summary>
    private void StartAttestationDirWatcher()
    {
        if (_attestationWatcher is not null) return;
        string dataDir = Environment.GetEnvironmentVariable("DATA_DIR") ?? "/data";
        string attDir = System.IO.Path.Combine(dataDir, "attestations");
        try { System.IO.Directory.CreateDirectory(attDir); } catch { }
        if (!System.IO.Directory.Exists(attDir)) return;

        // On boot, drain any existing files (dashboard may have written
        // attestations before we started watching).
        try
        {
            foreach (string f in System.IO.Directory.EnumerateFiles(attDir, "*.bin"))
            {
                TryConsumeAttestationFile(f);
                _handledAttestationFiles.TryAdd(f, 0);
            }
        }
        catch (Exception ex)
        {
            if (_logger.IsWarn) _logger.Warn($"[APOS-L2] initial attestation scan failed: {ex.Message}");
        }

        try
        {
            _attestationWatcher = new System.IO.FileSystemWatcher(attDir, "*.bin");
            _attestationWatcher.NotifyFilter = System.IO.NotifyFilters.FileName
                                             | System.IO.NotifyFilters.LastWrite
                                             | System.IO.NotifyFilters.Size;
            _attestationWatcher.Created += (s, e) => TryConsumeAttestationFile(e.FullPath);
            _attestationWatcher.Changed += (s, e) => TryConsumeAttestationFile(e.FullPath);
            _attestationWatcher.IncludeSubdirectories = false;
            _attestationWatcher.EnableRaisingEvents = true;
            if (_logger.IsInfo) _logger.Info($"[APOS-L2] watching {attDir} for relayer attestations");
        }
        catch (Exception ex)
        {
            if (_logger.IsWarn) _logger.Warn($"[APOS-L2] FileSystemWatcher init failed: {ex.Message}");
        }

        // v7.4.1: polling fallback. FileSystemWatcher on Linux Docker named
        // volumes sometimes misses Created events for files written by
        // another process in the same container. Polling at 1Hz guarantees
        // pickup within a second; the pool's first-write-wins TryAdd makes
        // duplicates harmless.
        try
        {
            string capturedDir = attDir;
            _attestationPollTimer = new System.Threading.Timer(_ =>
            {
                try
                {
                    int swept = 0, accepted = 0;
                    foreach (string f in System.IO.Directory.EnumerateFiles(capturedDir, "*.bin"))
                    {
                        swept++;
                        // One signature check per file: re-verifying the whole directory every
                        // second cost several cores on a busy node.
                        if (_handledAttestationFiles.ContainsKey(f)) continue;
                        if (TryConsumeAttestationFile(f)) accepted++;
                        if (new System.IO.FileInfo(f).Length == 117) _handledAttestationFiles.TryAdd(f, 0);
                    }

                    if (_handledAttestationFiles.Count > 500_000) _handledAttestationFiles.Clear();
                    if (accepted > 0 && _logger.IsInfo)
                        _logger.Info($"[APOS-L2] poll: swept {swept} files, {accepted} new attestations ingested (pool size now {RelayerAttestationPool.Count})");
                }
                catch { }
            }, null, TimeSpan.FromSeconds(1), TimeSpan.FromSeconds(1));
        }
        catch (Exception ex)
        {
            if (_logger.IsWarn) _logger.Warn($"[APOS-L2] attestation poll-timer init failed: {ex.Message}");
        }
    }

    /// <summary>
    /// Returns true if the file produced a NEW attestation entry in the
    /// pool (so the caller can count accepted vs duplicate).
    /// </summary>
    private static bool TryConsumeAttestationFile(string filePath)
    {
        try
        {
            if (!System.IO.File.Exists(filePath)) return false;
            byte[] entry = System.IO.File.ReadAllBytes(filePath);
            if (entry.Length != 117) return false;
            return RelayerAttestationPool.AddLocal(entry);
        }
        catch
        {
            return false;
        }
    }

    public string Name => SealEngineType;
    public string Description => "PoS Consensus Engine for UNPChain";
    public string Author => "UNPChain";
    public bool Enabled => _chainSpec.SealEngineType == SealEngineType;
    public string SealEngineType => Core.SealEngineType.PoS;

    public Task Init(INethermindApi nethermindApi)
    {
        _nethermindApi = nethermindApi;
        _logger = nethermindApi.LogManager.GetClassLogger();

        (IApiWithStores getFromApi, IApiWithBlockchain setInApi) = _nethermindApi.ForInit;

        _posConfig = nethermindApi.Config<IPoSConfig>();

        // Read engine parameters from chainspec
        var engineParams = getFromApi.ChainSpec.EngineChainSpecParametersProvider
            .GetChainSpecParameters<PoSChainSpecEngineParameters>();

        _transitionBlock = engineParams.TransitionBlock > 0 ? engineParams.TransitionBlock : _posConfig.TransitionBlock;
        _blockPeriod = engineParams.Period > 0 ? engineParams.Period : _posConfig.BlockPeriod;
        _epoch = engineParams.Epoch;
        _blockReward = engineParams.Reward;

        if (_logger.IsInfo) _logger.Info($"PoS: Initializing with transition block {_transitionBlock}, period {_blockPeriod}s, epoch {_epoch}");

        // v7.2.2 LAYER 2: install APOS fee-distributor with pointer address from
        // chainspec. The address comes from spec.engine.pos.params.aposPointer —
        // the SAME field every node reads on startup. Operators receive admin's
        // chainspec byte-identical via /api/wizard/bootstrap, so this address is
        // canonical across the network. No per-node config can override it; if a
        // node has a divergent chainspec they're literally on a different chain
        // (Nethermind genesis-hash check would already reject them).
        Address? canonicalPointer = null;
        if (!string.IsNullOrEmpty(engineParams.AposPointer)
            && engineParams.AposPointer.Length == 42
            && engineParams.AposPointer.StartsWith("0x", StringComparison.OrdinalIgnoreCase))
        {
            try { canonicalPointer = new Address(engineParams.AposPointer); } catch { canonicalPointer = null; }
        }
        // v7.3.0: enable relayer-attribution if the chainspec sets the
        // relayerAttributionBlock and an Ecdsa is available. Otherwise fall
        // through to the v7.2.x constructor (equal-split forever).
        long relayerBlock = engineParams.RelayerAttributionBlock ?? 0;
        long hardeningBlock = engineParams.HardeningBlock is > 0 ? engineParams.HardeningBlock.Value : long.MaxValue;
        ulong chainId = (ulong)(getFromApi.ChainSpec.ChainId);
        Nethermind.Crypto.IEthereumEcdsa? ecdsa = null;
        try { ecdsa = new Nethermind.Crypto.EthereumEcdsa(chainId); } catch { ecdsa = null; }
        APOSFeeDistributor aposDistributor;
        if (relayerBlock > 0 && ecdsa is not null)
        {
            aposDistributor = new APOSFeeDistributor(canonicalPointer, relayerBlock, chainId, ecdsa, nethermindApi.LogManager, hardeningBlock);
            // v7.4.0: wire the attestation pool to verify signatures and
            // subscribe to peer-inbound attestation messages. Also start
            // the FileSystemWatcher that picks up local attestations
            // written by the dashboard and broadcasts them to peers.
            try
            {
                RelayerAttestationPool.Wire(chainId, ecdsa);
                StartAttestationDirWatcher();
            }
            catch (Exception ex)
            {
                if (_logger.IsWarn) _logger.Warn($"[APOS-L2] failed to wire attestation pool/watcher: {ex.Message}");
            }
        }
        else
        {
            aposDistributor = new APOSFeeDistributor(canonicalPointer, nethermindApi.LogManager, hardeningBlock);
        }
        Nethermind.Consensus.Processing.BlockProcessor.PostTxStateMutationHook = (block, receipts, ws, spec) =>
        {
            if (block.Number < _transitionBlock) return;
            if (block.Number < hardeningBlock)
            {
                aposDistributor.Apply(block, receipts, ws, spec);
                return;
            }

            // From the hardening block a failing hook leaves no partial credits behind.
            Snapshot snapshot = ws.TakeSnapshot();
            try
            {
                aposDistributor.Apply(block, receipts, ws, spec);
            }
            catch (Exception ex)
            {
                ws.Restore(snapshot);
                if (_logger.IsError) _logger.Error($"[APOS-L2] fee distribution failed at block {block.Number}; reverted for this block", ex);
            }
        };
        if (_logger.IsInfo)
        {
            string ptrLog = canonicalPointer is null ? "(none — APOS not yet enabled in chainspec)" : canonicalPointer.ToString();
            string relayLog = relayerBlock > 0 ? $"; relayer-attribution at block {relayerBlock}" : "";
            _logger.Info($"PoS: Layer-2 APOS fee distributor installed; pointer={ptrLog}{relayLog}");
        }

        // Initialize validator manager
        _validatorManager = new ValidatorManager(nethermindApi.LogManager);

        // Extract initial validators from genesis ExtraData
        byte[] genesisExtraData = getFromApi.ChainSpec.Genesis?.ExtraData ?? [];
        var genesisValidators = ValidatorManager.ExtractValidatorsFromExtraData(genesisExtraData).ToList();

        if (genesisValidators.Count > 0)
        {
            _validatorManager.SetGenesisValidators(genesisValidators);
            if (_logger.IsInfo) _logger.Info($"PoS: Loaded {genesisValidators.Count} genesis validators: {string.Join(", ", genesisValidators)}");
        }
        else
        {
            if (_logger.IsWarn) _logger.Warn("PoS: No genesis validators found in ExtraData");
        }

        // v10.0: stricter header rules, switched on at a block number in the chainspec.
        if (_logger.IsInfo) _logger.Info(hardeningBlock == long.MaxValue ? "PoS: Header hardening not scheduled" : $"PoS: Header hardening active from block {hardeningBlock}");

        // Set up seal validator
        var sealValidator = new PoSSealValidator(
            NullSealValidator.Instance,
            _validatorManager,
            _transitionBlock,
            getFromApi.EthereumEcdsa!,
            nethermindApi.LogManager,
            hardeningBlock,
            _blockPeriod,
            nethermindApi.Timestamper);
        Nethermind.Consensus.Processing.BlockProcessor.PreProcessBlockCheck = block =>
            sealValidator.CheckSignerAtProcessing(
                _nethermindApi?.BlockTree?.FindParentHeader(block.Header, Nethermind.Blockchain.BlockTreeLookupOptions.TotalDifficultyNotNeeded),
                block.Header);

        // Give the seal validator access to state reader for on-chain validator sync
        if (setInApi.StateReader is not null)
        {
            sealValidator.SetStateReader(setInApi.StateReader);
        }

        setInApi.SealValidator = sealValidator;

        // Set up reward calculator
        setInApi.RewardCalculatorSource = new PoSRewardCalculatorSource(_transitionBlock, _blockReward);

        // Set up staking contract address for reading validators on-chain
        _stateReader = setInApi.StateReader;
        if (!string.IsNullOrEmpty(_posConfig.StakingContractAddress))
        {
            _validatorManager.StakingContractAddress = new Address(_posConfig.StakingContractAddress);
            if (_logger.IsInfo) _logger.Info($"PoS: Staking contract set to {_posConfig.StakingContractAddress}");
        }
        // v7.1.1 FIX: also try to load the staking contract from wizard-config
        // EAGERLY at boot. Operators who joined before admin deployed the
        // staking contract have an updated wizard-config (via /api/wizard/connect
        // refresh) but the chainspec they received predates the deploy. Without
        // this eager load, the plugin enters the validate→reject→never-add-head
        // deadlock where OnNewHeadBlock is never fired.
        if (_validatorManager.StakingContractAddress is null)
        {
            TryLoadStakingContractFromConfig();
        }
        // v7.1.1: register lazy-load callback so ValidatorManager can re-read
        // wizard-config any time the staking address is still null at validate
        // time (e.g. operator's wizard-config was updated AFTER plugin Init).
        _validatorManager.OnNeedReloadStakingAddress = () =>
        {
            if (_validatorManager.StakingContractAddress is null)
            {
                TryLoadStakingContractFromConfig();
                // Also kick a sync immediately if we now have an address + a
                // recent state root. Use the current head's state root.
                if (_validatorManager.StakingContractAddress is not null
                    && _stateReader is not null
                    && _nethermindApi?.BlockTree?.Head?.StateRoot is not null)
                {
                    _validatorManager.SyncValidatorsFromContract(
                        _stateReader, _nethermindApi.BlockTree.Head.StateRoot);
                }
            }
        };

        // Subscribe to new head blocks to sync validators from the staking contract
        if (getFromApi.BlockTree is not null)
        {
            getFromApi.BlockTree.NewHeadBlock += OnNewHeadBlock;
        }

        // Set up gossip policy (GossipPolicy lives on INethermindApi / IApiWithNetwork)
        // The default FullGossip is fine for PoS

        if (_logger.IsInfo) _logger.Info("PoS: Plugin initialized successfully");

        return Task.CompletedTask;
    }

    public IBlockProducer InitBlockProducer(ITxSource? additionalTxSource = null)
    {
        if (_nethermindApi is null)
            throw new InvalidOperationException("PoS plugin not initialized");

        (IApiWithBlockchain getFromApi, IApiWithBlockchain setInApi) = _nethermindApi.ForProducer;

        IBlocksConfig blocksConfig = getFromApi.Config<IBlocksConfig>();
        IMiningConfig miningConfig = getFromApi.Config<IMiningConfig>();

        if (!miningConfig.Enabled)
        {
            throw new InvalidOperationException("Mining is disabled but PoS block production was requested");
        }

        // Create the sealer
        _sealer = new PoSSealer(
            getFromApi.EngineSigner!,
            _validatorManager!,
            _transitionBlock,
            _nethermindApi.LogManager);

        setInApi.Sealer = _sealer;

        // Sync validators from contract at startup if contract address is known.
        // IMPORTANT: at Init() time (called earlier by Nethermind boot sequence)
        // setInApi.StateReader may still be null — it gets populated by a
        // subsequent init step. By the time InitBlockProducer runs, the
        // ForProducer scope's StateReader is available. Refresh from there if
        // our cached _stateReader is still null.
        if (_stateReader is null) _stateReader = getFromApi.StateReader;
        if (_validatorManager!.StakingContractAddress is not null && _stateReader is not null)
        {
            var headBlock = getFromApi.BlockTree?.Head;
            if (headBlock?.StateRoot is not null)
            {
                bool synced = _validatorManager.SyncValidatorsFromContract(_stateReader, headBlock.StateRoot);
                if (_logger.IsInfo)
                {
                    if (synced) _logger.Info($"PoS: Initial validator sync from staking contract succeeded at head {headBlock.Number}");
                    else        _logger.Warn($"PoS: Initial validator sync from staking contract returned no validators at head {headBlock.Number}, root {headBlock.StateRoot}");
                }
            }
            else
            {
                if (_logger.IsWarn) _logger.Warn($"PoS: Cannot sync validators at producer init — head/state-root is null (head={headBlock?.Number})");
            }
        }
        else
        {
            if (_logger.IsWarn) _logger.Warn($"PoS: Skipping validator sync at producer init (stakingContract={_validatorManager?.StakingContractAddress}, stateReader={(_stateReader is null ? "null" : "ok")})");
        }

        ReadOnlyBlockTree readOnlyBlockTree = getFromApi.BlockTree!.AsReadOnly();
        ITransactionComparerProvider transactionComparerProvider = getFromApi.TransactionComparerProvider;

        ReadOnlyTxProcessingEnv producerEnv = new(
            _nethermindApi.WorldStateManager!,
            readOnlyBlockTree,
            getFromApi.SpecProvider,
            getFromApi.LogManager);

        IReadOnlyTxProcessingScope scope = producerEnv.Build(Keccak.EmptyTreeHash);

        BlockProcessor producerProcessor = new(
            getFromApi.SpecProvider,
            getFromApi.BlockValidator,
            new PoSRewardCalculator(_transitionBlock, _blockReward),
            getFromApi.BlockProducerEnvFactory.TransactionsExecutorFactory.Create(scope),
            scope.WorldState,
            NullReceiptStorage.Instance,
            scope.TransactionProcessor,
            new BeaconBlockRootHandler(scope.TransactionProcessor, scope.WorldState),
            new BlockhashStore(getFromApi.SpecProvider, scope.WorldState),
            getFromApi.LogManager,
            new BlockProductionWithdrawalProcessor(new WithdrawalProcessor(scope.WorldState, getFromApi.LogManager)));

        IBlockchainProcessor producerChainProcessor = new BlockchainProcessor(
            readOnlyBlockTree,
            producerProcessor,
            getFromApi.BlockPreprocessor,
            getFromApi.StateReader,
            getFromApi.LogManager,
            BlockchainProcessor.Options.NoReceipts);

        OneTimeChainProcessor chainProcessor = new(
            scope.WorldState,
            producerChainProcessor);

        ITxFilterPipeline txFilterPipeline =
            TxFilterPipelineBuilder.CreateStandardFilteringPipeline(
                _nethermindApi.LogManager,
                getFromApi.SpecProvider,
                blocksConfig);

        TxPoolTxSource txPoolTxSource = new(
            getFromApi.TxPool,
            getFromApi.SpecProvider,
            transactionComparerProvider,
            getFromApi.LogManager,
            txFilterPipeline);

        IGasLimitCalculator gasLimitCalculator = new TargetAdjustedGasLimitCalculator(getFromApi.SpecProvider, blocksConfig);

        PoSBlockProducer blockProducer = new(
            additionalTxSource.Then(txPoolTxSource),
            chainProcessor,
            scope.WorldState,
            getFromApi.Timestamper,
            _sealer,
            gasLimitCalculator,
            getFromApi.SpecProvider,
            _validatorManager!,
            _transitionBlock,
            _blockPeriod,
            _epoch,
            getFromApi.LogManager);

        return blockProducer;
    }

    public IBlockProducerRunner InitBlockProducerRunner(IBlockProducer blockProducer)
    {
        _blockProducerRunner = new PoSBlockProducerRunner(
            _nethermindApi!.BlockTree!,
            _nethermindApi.Timestamper,
            blockProducer,
            _blockPeriod,
            _nethermindApi.LogManager);

        _nethermindApi.DisposeStack.Push(_blockProducerRunner);
        return _blockProducerRunner;
    }

    public Task InitRpcModules()
    {
        // No custom RPC modules for now
        return Task.CompletedTask;
    }

    public ValueTask DisposeAsync()
    {
        if (_nethermindApi?.BlockTree is not null)
        {
            _nethermindApi.BlockTree.NewHeadBlock -= OnNewHeadBlock;
        }
        return ValueTask.CompletedTask;
    }

    /// <summary>
    /// Called on every new head block. Syncs the staked validator set from the
    /// staking contract's on-chain storage so all nodes agree on the validator set.
    /// </summary>
    private void OnNewHeadBlock(object? sender, BlockEventArgs e)
    {
        if (_validatorManager is null) return;

        // Refresh state reader if we never got one at Init/InitBlockProducer time.
        if (_stateReader is null && _nethermindApi is not null)
        {
            _stateReader = _nethermindApi.StateReader;
        }
        if (_stateReader is null) return;

        // If no staking contract address is set yet, try reading it from the wizard config file
        if (_validatorManager.StakingContractAddress is null)
        {
            TryLoadStakingContractFromConfig();
        }
        if (_validatorManager.StakingContractAddress is null) return;

        Hash256? stateRoot = e.Block.Header.StateRoot;
        if (stateRoot is null) return;

        // NOTE: do NOT skip on `Block.Number < _transitionBlock`. The very last
        // pre-transition block is where the staking contract finishes its
        // bootstrap (admin auto-registered in constructor), and we MUST have
        // the validator set populated before we can sign the first PoS block
        // (which is _transitionBlock itself). Without this sync running on
        // the pre-transition head, IsValidator() falls back to genesis
        // validators (foreign chain) and our local validator can never sign.
        try
        {
            bool synced = _validatorManager.SyncValidatorsFromContract(_stateReader, stateRoot);
            if (synced && _logger.IsDebug)
            {
                _logger.Debug($"PoS: Validator set re-synced from staking contract at block {e.Block.Number}");
            }
        }
        catch (Exception ex)
        {
            if (_logger.IsDebug) _logger.Debug($"PoS: Error syncing validators on block {e.Block.Number}: {ex.Message}");
        }
    }

    /// <summary>
    /// Tries to load the staking contract address from the wizard config file (wizard-config.json).
    /// This handles the case where the contract is deployed at runtime via the dashboard.
    /// v7.1.0 (audit N-C4): once StakingContractAddress is set, REFUSE to ever
    /// change it — defeats the attack where any process able to write the
    /// config file atomically swaps the staking pointer to attacker bytecode.
    /// Also uses a strict JSON parse instead of naive string-search so that
    /// only the actual top-level "stakingContract" property is honored.
    /// </summary>
    private void TryLoadStakingContractFromConfig()
    {
        // Refuse to update once set — single-write semantic prevents hijack.
        if (_validatorManager?.StakingContractAddress is not null) return;
        try
        {
            string dataDir = Environment.GetEnvironmentVariable("DATA_DIR")
                ?? Path.Combine(Path.GetDirectoryName(typeof(PoSPlugin).Assembly.Location) ?? ".", "data");
            string cfgPath = Path.Combine(dataDir, "wizard-config.json");
            if (!File.Exists(cfgPath)) return;

            string json = File.ReadAllText(cfgPath);
            // Use System.Text.Json so an attacker can't smuggle "stakingContract"
            // through a comment or unrelated key whose name contains the string.
            using System.Text.Json.JsonDocument doc = System.Text.Json.JsonDocument.Parse(json);
            if (!doc.RootElement.TryGetProperty("stakingContract", out var prop)) return;
            if (prop.ValueKind != System.Text.Json.JsonValueKind.String) return;
            string? addr = prop.GetString();
            if (addr is null || addr.Length != 42 || !addr.StartsWith("0x", StringComparison.Ordinal)) return;
            // Hex sanity check
            for (int i = 2; i < 42; i++)
            {
                char ch = addr[i];
                bool isHex = (ch >= '0' && ch <= '9') || (ch >= 'a' && ch <= 'f') || (ch >= 'A' && ch <= 'F');
                if (!isHex) return;
            }
            _validatorManager!.StakingContractAddress = new Address(addr);
            if (_logger.IsInfo) _logger.Info($"PoS: Loaded staking contract from wizard config: {addr} (immutable from now on)");
        }
        catch (Exception ex)
        {
            if (_logger.IsTrace) _logger.Trace($"PoS: Could not load staking contract from config: {ex.Message}");
        }
    }

    /// <summary>
    /// Null seal validator used as base when PoS is the only engine (no underlying Clique).
    /// </summary>
    private class NullSealValidator : ISealValidator
    {
        public static readonly NullSealValidator Instance = new();
        public bool ValidateParams(BlockHeader parent, BlockHeader header, bool isUncle = false) => true;
        public bool ValidateSeal(BlockHeader header, bool force) => true;
    }
}
