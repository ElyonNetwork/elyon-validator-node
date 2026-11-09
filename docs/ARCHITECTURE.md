# Architecture

## Components

```
                         ┌───────────────────────────────┐
  Wallets, dApps,        │ JSON-RPC proxy (dashboard)     │
  exchanges  ───HTTPS──► │  method allowlist, rate limits │
                         │  relayer attestation signing   │
                         └───────────────┬───────────────┘
                                         │ 127.0.0.1:8540
                         ┌───────────────▼───────────────┐
                         │ Elyon client (Nethermind fork) │
   other validators ◄──► │  EVM execution, tx pool, P2P   │
   (devp2p, port 30303)  │  APOS consensus engine         │
                         │  In-block fee settlement       │
                         └───────────────┬───────────────┘
                                         │ state
                         ┌───────────────▼───────────────┐
                         │ Contracts: StakingContract,    │
                         │  UNPRegistry, APOSPointer      │
                         └───────────────────────────────┘
```

Each node is a single Docker image holding the client, the dashboard and the RPC proxy. The client
listens on `127.0.0.1:8540` and is reachable only through the proxy.

## Client

`src/Nethermind/` is a fork of Nethermind 1.32. Elyon's additions are concentrated in a few places:

| Path | Purpose |
|---|---|
| `Nethermind.Consensus.PoS/` | The APOS engine: `PoSPlugin`, `PoSSealValidator`, `PoSBlockProducer`, `ValidatorManager`, `APOSFeeDistributor`, `RelayerAttestation*` |
| `Nethermind.Consensus/Processing/BlockProcessor.cs` | Hooks for the fee settlement and the pre-execution signer check |
| `Nethermind.Network/P2P/.../UnpRelayerAttestationMessage*` | P2P gossip for relayer attestations |
| `Nethermind.Core/ProductInfo.cs` | Client identity (`Elyonchain/v1.32.0`) |

All other files come from upstream Nethermind and are unchanged in behaviour.

## Consensus

See [CONSENSUS.md](CONSENSUS.md).

## Fee settlement

See [FEES-AND-REWARDS.md](FEES-AND-REWARDS.md) and [LAYER-2.md](LAYER-2.md).

## Contracts

| Contract | Role | Mainnet address |
|---|---|---|
| `StakingContract` | Validator set and stakes | `0x04250541308a1d1c633de3d435e361402505cf29` |
| `UNPRegistry` | Validators' registration, fee accounting, staking packages, delegation | `0x669f32c7590057398753ae21f15b3dab1e80d4cd` |
| `APOSPointer` | Points the client to the current registry, with a 24-hour timelock on changes (see SC-5 in [SECURITY.md](../SECURITY.md)) | `0xaac39663a4aff8f6e20f1bd2c186a941ac9effb1` |

The deployed bytecode of these three contracts was compared with a compile of this source and matches.

## Explorer and live blocks

| Component | Path | What it does |
|---|---|---|
| Explorer | `Explorer/` | Indexes the chain into Postgres; blocks, transactions, addresses, tokens, contract verification and fee attestations |
| Live blocks | `BlocksViewer/` | Polls a node and streams the last 100 blocks with full headers to the browser |
