<div align="center">

# Elyon Chain

**An independent EVM proof-of-stake chain that settles transaction fees to the nodes that serve users, inside the block.**

Native token: **ELN** · Mainnet chain ID: **55452773** · Block time: **2 seconds**

[Run a node](docs/NODE-SETUP.md) · [Explorer](https://explorer.elyon.network) · [Live blocks](https://blocks.elyon.network) · [Security](SECURITY.md) · [Decentralization](docs/DECENTRALIZATION.md)

</div>

---

## What Elyon Chain is

Elyon Chain is an EVM-compatible blockchain with its own validators and its own consensus. Wallets,
contracts and tools built for Ethereum work without changes. **ELN** is its native token and default
gas currency.

The client is a fork of [Nethermind](https://github.com/NethermindEth/nethermind), a production Ethereum
client. On top of that base, the Elyon team built:

* **APOS consensus**: a proof-of-stake engine with a validator set read from a smart contract, a fixed
  rotation, and backup validators that step in when a validator misses its slot.
* **In-block fee settlement**: after each block's transactions run, the priority fee of each one is
  moved to a registry contract and credited to the RPC node that relayed it, before the block's state
  root is computed. Every node has to compute the same split or reject the block. Elyon documents this
  as its settlement layer ("Layer 2"); [docs/LAYER-2.md](docs/LAYER-2.md) explains exactly what that means
  and what it does not mean.
* **Relayer attestations (`URELAY1`)**: signed records carried in the block header that bind a
  transaction to the node that received it.
* **Node dashboard, block explorer and live block viewer**, all in this repository.

## Capabilities

| Area | What it does |
|---|---|
| Execution | Full EVM, EIP-1559 fees, standard JSON-RPC |
| Consensus | APOS proof of stake; 7 validators on mainnet; 2-second rotation; automatic backup on a missed slot |
| Validators | Staking contract, 100-block unbonding; [new validator entry is currently paused](docs/DECENTRALIZATION.md#why-validator-entry-is-paused) |
| Fee model | Base fee burned; priority fee split between the relaying node and the network, in the same block |
| Node operators | Earn a tiered share of the fees of transactions sent through their RPC; can run delegation packages |
| Node software | One Docker image: client, dashboard, JSON-RPC proxy with method allowlist and rate limits |
| Transparency | Public source, public chain, [live view of every block](https://blocks.elyon.network) with full header data |

## Repository layout

| Path | What it is |
|---|---|
| `src/Nethermind/` | The client. Elyon's consensus engine is in `Nethermind.Consensus.PoS/`, and the live network specs are in `Nethermind.Runner/chainspec/` |
| `contracts/` | Solidity: `StakingContract`, `UNPRegistry`, `APOSPointer` and others (see note below) |
| `dashboard/` | Node dashboard, setup wizard and JSON-RPC proxy (Node.js) |
| `Explorer/` | Block explorer |
| `BlocksViewer/` | The service behind blocks.elyon.network |
| `elyon-bot/` | `elyon`, the trading-bot client for ElyonDex: command line and local API, with the key kept on the user's computer |
| `scripts/setup-node.sh` | Installs and starts a node |
| `Dockerfile.aposunpchain` | Builds the node image from this source |
| `docs/` | Documentation listed below |

`UNPRegistry` and similar names are historical names from an earlier codebase; they are kept because
deployed contracts and on-chain storage layouts depend on them.

## Run a node

```bash
git clone https://github.com/ElyonNetwork/elyon-validator-node.git
cd elyon-validator-node
docker build -f Dockerfile.aposunpchain -t elyon-node:local .
sudo bash scripts/setup-node.sh --image elyon-node:local --public-ip <your-public-ip>
```

The full guide covers requirements, verification, serving RPC, registering to earn fees and becoming a
validator: **[docs/NODE-SETUP.md](docs/NODE-SETUP.md)**.

## Trading bots on ElyonDex

[`elyon-bot/`](elyon-bot) is `elyon`, the open-source client that lets a trading bot use every spot and futures
feature of [ElyonDex](https://dex.elyon.network) by command, from any programming language. The bot's key is
created on the user's own computer, stored encrypted with the user's password, and never sent anywhere.

* Downloads for Windows, macOS, Linux and Docker, with step-by-step guides: **[dex.elyon.network/bots](https://dex.elyon.network/bots)**
* Commands, local HTTP API and security model: [elyon-bot/README.md](elyon-bot/README.md)
* Reproducible release: the tag `elyon-bot-v0.1.0` rebuilds the published binaries byte for byte
  (`git checkout elyon-bot-v0.1.0 && scripts/release-build.sh`, with Docker installed)

## Networks

| | Mainnet | Testnet |
|---|---|---|
| Chain ID | 55452773 | 55452774 |
| RPC | https://mainnet.elyon.network/rpc | https://testnet.elyon.network/rpc |
| Explorer | https://explorer.elyon.network | https://explorertestnet.elyon.network |
| Staking contract | `0x04250541308a1d1c633de3d435e361402505cf29` | see testnet dashboard |

Add ELN to a wallet as a custom network using the values above. Currency symbol **ELN**, 18 decimals.

## Documentation

| Document | Contents |
|---|---|
| [NODE-SETUP.md](docs/NODE-SETUP.md) | How to run a node, step by step |
| [ARCHITECTURE.md](docs/ARCHITECTURE.md) | How the parts fit together |
| [CONSENSUS.md](docs/CONSENSUS.md) | How blocks are formed and validated |
| [FEES-AND-REWARDS.md](docs/FEES-AND-REWARDS.md) | Who earns what, and how the split works |
| [LAYER-2.md](docs/LAYER-2.md) | What "Layer 2" means here |
| [DECENTRALIZATION.md](docs/DECENTRALIZATION.md) | Exactly how decentralized the network is today |
| [EXCHANGE-INTEGRATION.md](docs/EXCHANGE-INTEGRATION.md) | Parameters and guidance for exchanges |
| [SECURITY.md](SECURITY.md) | Security review: findings, fixes and open items |
| [elyon-bot/README.md](elyon-bot/README.md) | The trading-bot client: install, commands, local API, key security |

## Security

The team's November 2026 review covered the consensus engine, fee settlement, node software, contracts and public
infrastructure. [SECURITY.md](SECURITY.md) lists every finding, what was fixed and deployed, and what is still open.
It was an internal review; an independent audit is still recommended.

To report a vulnerability, please do not post technical details publicly. Open an issue titled "Security contact
request", without details, and the team will arrange a private channel.

## How decentralized is it?

| | Today |
|---|---|
| Validators producing blocks | 7, on separate servers, each with its own key |
| Who operates them | The Elyon team |
| Becoming a validator | Open by design in the staking contract, currently paused until an offline validator can be removed |
| Running a full node | Open to anyone |
| Earning as an RPC operator | Open, after approval in the registry |
| Administrative control | One key today; moving to multi-signature control is planned |
| Slashing and finality gadget | Not implemented |

Elyon Chain is **not yet decentralized in the sense of independent operators**. Seven validators give it real
availability and fault tolerance, and [docs/DECENTRALIZATION.md](docs/DECENTRALIZATION.md) states exactly what would
change the rest.

## License and credits

The client in `src/Nethermind/` is derived from [Nethermind](https://github.com/NethermindEth/nethermind)
and remains under the **LGPL-3.0** (see `LICENSE-LGPL`, and `LICENSE-GPL` for the parts that use GPL-3.0).
Elyon's changes to those files are released under the same license. Everything else in this repository
is released under the **MIT License** (see `LICENSE`) unless a file states otherwise. Solidity contracts
carry their own SPDX headers.
