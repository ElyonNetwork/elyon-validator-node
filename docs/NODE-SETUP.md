# Running an Elyon Chain node

This is the procedure used for the nodes on Elyon mainnet. A node takes about 15 minutes of work, then
around 12 hours on the recommended hardware to synchronise the chain from genesis, and longer as the
chain grows.

* [Requirements](#requirements)
* [1. Build the node image](#1-build-the-node-image)
* [2. Start a full node](#2-start-a-full-node)
* [3. Check that it is healthy](#3-check-that-it-is-healthy)
* [4. Serve RPC or earn relay fees](#4-serve-rpc-or-earn-relay-fees)
* [5. Become a block-producing validator](#5-become-a-block-producing-validator)
* [Operations](#operations)
* [Troubleshooting](#troubleshooting)

## Requirements

| | Minimum | Used on mainnet |
|---|---|---|
| OS | Linux with Docker 20.10+ | Ubuntu 24.04 |
| CPU and RAM | 4 cores, 8 GB | 6 cores, 12 GB |
| Disk | 100 GB SSD | 200 GB SSD |
| Network | Static public IP, inbound TCP and UDP 30303 | Static public IP |
| Clock | NTP enabled. Blocks more than 15 seconds ahead of the local clock are rejected | `timedatectl` shows synchronized |

## 1. Build the node image

```bash
git clone https://github.com/ElyonNetwork/elyon-validator-node.git
cd elyon-validator-node
docker build -f Dockerfile.aposunpchain -t elyon-node:local .
```

The build compiles the client from this repository and takes 20 to 40 minutes.

## 2. Start a full node

```bash
sudo bash scripts/setup-node.sh --image elyon-node:local --public-ip <your-public-ip>
```

The script downloads the network settings (`chainspec`, bootstrap peer, contract addresses) from
`https://mainnet.elyon.network/api/wizard/bootstrap`, writes them to `/opt/elyon/data` and starts the
container. By default the RPC port and the dashboard are bound to `127.0.0.1` only. Only the P2P port
is reachable from outside.

Open TCP and UDP 30303 on the host firewall. The node then performs a **full sync**: it downloads every
block from genesis and re-executes it. Each block is checked against its state root, so the node
arrives at the head having verified the whole history itself.

## 3. Check that it is healthy

```bash
curl -s -X POST -H 'content-type: application/json' \
  --data '{"jsonrpc":"2.0","id":1,"method":"eth_blockNumber","params":[]}' \
  http://127.0.0.1:8545
```

Compare the result with [blocks.elyon.network](https://blocks.elyon.network). The node is ready when it
tracks the head and its block hashes match. Use `eth_getBlockByNumber` to compare a few recent blocks.

The dashboard is at `http://127.0.0.1:3000` on the node. Reach it through an SSH tunnel:

```bash
ssh -L 3000:127.0.0.1:3000 root@<your-server>
```

## 4. Serve RPC or earn relay fees

A node's JSON-RPC endpoint exposes only `eth_`, `net_` and `web3_` methods. Put HTTPS in front of port
8545 with your own reverse proxy, then pass `--expose-rpc` to `setup-node.sh` or proxy from localhost.

To earn fees for the transactions your node relays, register in the APOS registry:

1. Create a wallet for the node and fund it with ELN.
2. In the dashboard, apply as a validator with a staking package. The network admin approves the
   application.
3. Once your status is `ACTIVE`, every transaction sent through your RPC is attested by your node and
   earns your tier's share of its priority fee, in the same block. See
   [FEES-AND-REWARDS.md](FEES-AND-REWARDS.md).

## 5. Become a block-producing validator

Block production is separate from earning relay fees: it needs a stake in the staking contract
(`0x04250541308a1d1c633de3d435e361402505cf29`) and a node holding the validator key.

> Validator entry is **currently paused** by the network admin. See
> [DECENTRALIZATION.md](DECENTRALIZATION.md) for the reason and the path to reopening it.

When entry is open, the steps are:

1. Create the validator key and store it safely. It signs every block you produce.
2. Start a node with it and wait until it is fully synced:

   ```bash
   sudo bash scripts/setup-node.sh --image elyon-node:local --public-ip <ip> \
     --validator-key-file /root/validator.key
   ```

3. Fund the address with the minimum stake plus gas, and call `stake()` on the staking contract from
   that address. The node joins the rotation at the next block and produces whenever its turn comes.

Do not stake before the node is synced and online: from that block on the chain expects you to produce.

To leave, call `requestUnstake()`. You leave the rotation immediately and can call `withdraw()` after
100 blocks.

## Operations

| Task | How |
|---|---|
| Logs | `docker logs -f elyon-node` |
| Stop or start | `docker stop elyon-node`, `docker start elyon-node` |
| Update | Rebuild the image, then run `setup-node.sh` again with the same options. The chain data in `/opt/elyon/data` is kept |
| Back up | `/opt/elyon/data/wizard-config.json` (holds the encrypted validator key) and `/opt/elyon/data/.config-passphrase`. Store them separately and offline |
| Peers | `curl` `net_peerCount` on the RPC port |

## Troubleshooting

| Symptom | Cause and fix |
|---|---|
| `net_peerCount` stays 0 | Port 30303 is closed, or `--public-ip` is wrong |
| Node stops at a block with `invalid block` | The chainspec differs from the network's. Remove `/opt/elyon/data/chainspec.json` and run `setup-node.sh` again |
| Blocks rejected as too far ahead | The clock is wrong. Enable NTP |
| Slow sync | Sync is limited by disk speed. Use SSD storage |
