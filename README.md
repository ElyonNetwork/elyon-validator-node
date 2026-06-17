<div align="center">

# 🟢 Elyon Chain — Validator Node

**Run your own Elyon Chain validator. Join the network, stake, serve transactions, and earn your tier‑based share of the gas fees.**

[![Docker](https://img.shields.io/badge/docker-elyonchain%2Fvalidatornode-2496ED?logo=docker&logoColor=white)](https://hub.docker.com/r/elyonchain/validatornode)
[![Consensus](https://img.shields.io/badge/consensus-APOS%20(Proof%20of%20Stake)-15a878)](#how-validators-earn)
[![License](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

</div>

---

> **This is the validator‑only distribution.** It contains everything you need to run a validator and **nothing about administering the chain** — there is no `/admin` dashboard, no chain‑creation/approval/tier controls, and no faucet. Those belong to the network's admin node. See [What's intentionally not here](#whats-intentionally-not-here).

## Table of contents

- [Overview](#overview)
- [How validators earn](#how-validators-earn)
- [Features](#features)
- [Requirements](#requirements)
- [Quick start](#quick-start)
- [Step‑by‑step setup](#step-by-step-setup)
- [Configuration](#configuration)
- [Run with docker‑compose](#run-with-docker-compose)
- [Put it behind HTTPS (optional)](#put-it-behind-https-optional)
- [Updating](#updating)
- [Backups](#backups)
- [Build from source](#build-from-source)
- [What's inside](#whats-inside)
- [Security](#security)
- [Troubleshooting](#troubleshooting)
- [FAQ](#faq)
- [Glossary](#glossary)
- [What's intentionally not here](#whats-intentionally-not-here)
- [License](#license)

---

## Overview

**Elyon Chain** is an EVM Layer‑2 network running a patched [Nethermind](https://nethermind.io) client with **APOS** (Authorized Proof of Stake) consensus and a native coin, **ELN**. Gas follows the standard Ethereum EIP‑1559 model: the base fee is burned, and the priority tip is split between the **relaying validator** (by tier) and the network admin.

A **validator node** is an operator‑run node that:

1. Joins an existing Elyon chain and stays in sync.
2. Stakes ELN through an admin‑published **staking package** to become an approved validator.
3. Relays user transactions through its own RPC and earns a **tier‑based share** of their tips.
4. Publishes its own **delegator packages** so others can delegate ELN into the validator's pool (which raises the validator's tier).

This repository is a self‑contained package: a `Dockerfile` that builds the validator image on top of the published Elyon chain engine, plus the validator dashboard you'll use day‑to‑day.

## How validators earn

Every transaction pays `gasUsed × effectiveGasPrice`, made of two parts:

| Part | Who gets it |
|---|---|
| **Base fee** (EIP‑1559) | 🔥 **Burned** — nobody receives it |
| **Priority tip** (`effectiveGasPrice − baseFee`) | Split: **your tier %** to the relaying validator, the remainder to the admin |

- Your **fee‑share %** is set by the network's **tier curve**: as your **pool** (your own stake **+** your delegators' deposits) crosses each threshold, your share rises to that tier.
- You earn a tip share **only on transactions relayed through your node's RPC** (your node signs a verified attestation for each one) and **only while you are an `ACTIVE` validator**.
- Your staking package also accrues **APR** on your own stake, claimable any time.

> **Tip:** the network enforces a minimum gas price, so every accepted transaction carries a real tip — there is no "free" transaction that pays validators nothing.

## Features

- ✅ One‑command Docker deployment; joins an existing chain via a single `ADMIN_URL`.
- ✅ Clean web panel at **`/manager`**: My Validator, Delegators, Staking Packages, Send ELN, Fee Earnings, PoS Staking, and a live block Explorer.
- ✅ Key stays in your browser tab — signed per‑transaction, never uploaded.
- ✅ Publishes your own delegator packages (rate, lock, minimum, early‑exit penalty).
- ✅ Runs as a non‑root user inside the container; data persisted to a Docker volume.
- ✅ **No admin surface** — this node can never administer the chain.

## Requirements

| | Minimum | Recommended |
|---|---|---|
| **OS** | Linux with Docker 20.10+ | Ubuntu 22.04/24.04 |
| **CPU / RAM** | 2 vCPU / 4 GB | 4 vCPU / 8 GB |
| **Disk** | 40 GB SSD | 100 GB+ SSD (grows with the chain) |
| **Network** | Outbound to the admin node; inbound `30303` for P2P | Static public IP |

**Ports**

| Port | Purpose | Expose publicly? |
|---|---|---|
| `3000` | Dashboard + JSON‑RPC proxy | Behind a reverse proxy / firewall |
| `8545` | JSON‑RPC | Only if you need external RPC |
| `30303` (TCP+UDP) | P2P with the chain | **Yes** (so the node can peer) |

You also need the **admin node URL** of the chain you're joining, e.g. `http://203.0.113.10:3000`, and some **ELN** in your validator wallet to stake (ask the network admin / use the network faucet).

## Quick start

```bash
docker run -d --name elyon-validator --restart unless-stopped \
  -p 3000:3000 -p 8545:8545 -p 30303:30303 -p 30303:30303/udp \
  -v elyon-validator-data:/data \
  -e ADMIN_URL=http://<ADMIN_NODE_IP>:3000 \
  elyonchain/validatornode:latest
```

Then open **`http://<your-server-ip>:3000`** — it lands on the validator panel (`/manager`).

## Step‑by‑step setup

### 1. Start the node

Run the [Quick start](#quick-start) command, replacing `<ADMIN_NODE_IP>` with the chain's admin node IP. Check it's healthy:

```bash
docker ps                      # STATUS should show "healthy"
docker logs -f elyon-validator # watch it boot + start syncing
```

### 2. Open the panel and sign in

Browse to `http://<your-server-ip>:3000`. You'll see the **sign‑in gate**:

- **Have a key file?** Drop your `.txt` key file (or paste a bare 64‑hex private key). This is your validator wallet — it's held in the browser tab only.
- **New operator?** Click **"Create a key for me & set up this node"** — it generates a fresh key, downloads the backup `.txt` (⚠️ **save it immediately**), joins the chain, and signs you in.

### 3. Join the chain

If you used "Create a key", joining is automatic. Otherwise the node fetches the chain's bootstrap (chainspec + peer) from `ADMIN_URL`, starts its local engine, and begins syncing. Watch **Explorer** — the block height should be climbing.

### 4. Apply as a validator

Open **My Validator → Apply**:

1. Pick one of the admin's **staking packages** (each has a lock term, minimum stake, and APR).
2. Enter your **stake amount** — at least the larger of the network minimum and the package minimum. Your stake **locks for the package term**.
3. Press **🚀 Apply as Validator**. Your application is now staked and **pending**.

### 5. Get approved

The network admin reviews applications and approves yours, issuing your **public Elyon code** (e.g. `VAL‑ABC123`). Your panel refreshes automatically to **ACTIVE** and shows the code — share it with delegators so they can fund your pool.

### 6. Publish a package for delegators

Open **My Validator → My Packages → Create a package**:

- **Name**, **Lock (days)**, **Monthly rate %** (capped by your package's APR), **Minimum deposit (ELN)**, **Early‑exit penalty %** (max 20%).
- Press **📦 Publish package**. Delegators can now join it from your public page; each deposit locks in that package's terms.

### 7. Run, earn, manage

- **Fee Earnings** — your accrued tip share; withdraw any time.
- **My Validator** — claim daily APR on your stake; watch your pool/tier.
- **Delegators** — see who has delegated; release funds or send gifts.
- **Send ELN** — transfer the native coin.

> Keep your pool **≥ the network minimum**. If it drops below, your fee share pauses (status `BELOW_MIN`) until you top up or receive new delegations — then it auto‑restores.

## Configuration

All settings are environment variables — no rebuild needed.

| Variable | Default | Description |
|---|---|---|
| `ADMIN_URL` | — | **Required.** Admin node URL to bootstrap/join from, e.g. `http://203.0.113.10:3000`. |
| `NODE_ROLE` | `operator` | Fixed to `operator` in this image (validator). |
| `DASHBOARD_PORT` | `3000` | Dashboard + RPC‑proxy port. |
| `RPC_URL` | local node | Override the chain RPC the dashboard reads/writes (advanced). |
| `DATA_DIR` | `/data` | Persisted chainspec, DB, keys, config. Mount a volume here. |
| `NODE_LABEL` | `Elyon Validator Node` | Display name in the panel. |

**Always** mount a volume at `/data` so your keys, config, and chain DB survive restarts:

```bash
-v elyon-validator-data:/data
```

## Run with docker‑compose

```yaml
# docker-compose.yml
services:
  validator:
    image: elyonchain/validatornode:latest
    container_name: elyon-validator
    restart: unless-stopped
    environment:
      ADMIN_URL: "http://<ADMIN_NODE_IP>:3000"
    ports:
      - "3000:3000"
      - "8545:8545"
      - "30303:30303"
      - "30303:30303/udp"
    volumes:
      - elyon-validator-data:/data
    healthcheck:
      test: ["CMD", "curl", "-fsS", "http://127.0.0.1:3000/api/auth/status"]
      interval: 30s
      timeout: 5s
      retries: 3

volumes:
  elyon-validator-data:
```

```bash
docker compose up -d
```

## Put it behind HTTPS (optional)

The container serves plain HTTP on `3000`; front it with your own reverse proxy for TLS. Minimal Nginx:

```nginx
server {
    listen 443 ssl;
    server_name validator.example.com;
    ssl_certificate     /etc/letsencrypt/live/validator.example.com/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/validator.example.com/privkey.pem;
    location / {
        proxy_pass         http://127.0.0.1:3000;
        proxy_set_header   Host $host;
        proxy_set_header   X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header   X-Forwarded-Proto $scheme;
    }
}
```

> The dashboard already trusts the loopback proxy and reads the real client IP from `X-Forwarded-For`.

## Updating

```bash
docker pull elyonchain/validatornode:latest
docker rm -f elyon-validator
# re-run the same `docker run …` command — your /data volume is preserved
```

Your chain DB, keys, and config live in the `/data` volume and survive the upgrade.

## Backups

Two things matter:

1. **Your key file** (`.txt`) — back it up offline the moment it's generated. Losing it means losing access to your validator wallet and its staked funds.
2. **The `/data` volume** — holds chain DB + node config. To snapshot:

```bash
docker run --rm -v elyon-validator-data:/data -v "$PWD":/backup alpine \
  tar czf /backup/elyon-validator-data.tgz -C /data .
```

## Build from source

```bash
git clone https://github.com/Elyon/elyon-validator-node.git
cd elyon-validator-node
docker build -t elyonchain/validatornode:latest .
```

The image builds **on top of the published chain engine** (`FROM elyonchain/node`), which supplies the patched Nethermind binaries and entrypoint; this repo replaces the dashboard with the validator‑only build.

## What's inside

```
.
├── Dockerfile          # builds the validator image (FROM elyonchain/node)
├── README.md
└── dashboard/          # the validator-only web app (Node.js + Express)
    ├── server.js       #   routes + RPC proxy; admin routes removed, admin API hard-disabled
    ├── apos.js         #   validator/delegator + read endpoints
    ├── operator-panel.js, simple-admin.js, leaderboard.js, bridge.js
    ├── *-build.json    #   contract ABIs/bytecode (registry, pointer, token, staking)
    └── public/
        ├── simple-admin/   # /manager — the validator panel (no admin tabs)
        ├── operator/       # /node    — join / earnings portal
        ├── owner.html      #            delegator portal
        ├── validator.html  #            your public validator page
        └── …               #            explorer, leaderboard, assets
```

## Security

- 🔑 **Your key never leaves the browser tab** — it's used to sign each transaction client‑side and is never persisted server‑side.
- 👤 The container runs the dashboard as a **non‑root** user; code under `/dashboard` and `/nethermind` is read‑only.
- 🚫 **No admin capability** — admin API paths return `404` and there is no admin UI, so a compromised validator panel cannot administer the chain.
- 🌐 Don't expose port `3000` directly to the internet without a reverse proxy + access control. Expose `30303` for P2P.
- 💾 Treat your key file like cash. Anyone with it controls your validator wallet.

## Troubleshooting

| Symptom | Likely cause / fix |
|---|---|
| Panel loads but block height stays `0` | Can't reach the admin node. Check `ADMIN_URL`, that the admin node is up, and that outbound + `30303` are open. |
| `Peers: 0` / not syncing | Inbound `30303` (TCP **and** UDP) is firewalled. Open it; restart the container. |
| "key does not match an authorized address" | You're signing with a key this node isn't configured for. Use the key you set this node up with, or re‑run setup with your key. |
| Transaction rejected as too cheap | The chain enforces a minimum gas price. Use the node's suggested gas price (the wallet does this automatically). |
| `Pruned history unavailable` on a receipt | A harmless race right after a tx mines; the dashboard retries automatically. |
| Apply fails: "stake below minimum" | Stake at least the larger of the network minimum and the package minimum. |
| Can't withdraw stake yet | Your package lock hasn't elapsed. Withdrawals are allowed after the lock (or if the admin rejects/suspends you). |
| Container unhealthy | `docker logs elyon-validator` — usually a missing `ADMIN_URL` or unreachable admin node. |

## FAQ

**Do I need the whole chain history?** No — the node syncs from the admin/peers and prunes history; you don't reburn genesis.

**Can this node create or administer a chain?** No. This is validator‑only by design. Admin functions live on the admin node.

**How much do I need to stake?** At least the larger of the network minimum and your chosen package's minimum. More stake (and more delegations) raises your tier and fee share.

**When do I get paid?** Tip shares accrue per block to your on‑chain balance; withdraw any time from **Fee Earnings**. Package APR accrues on your stake and is claimable from **My Validator**.

**What happens if I withdraw all my own stake?** If delegators keep your pool above the network minimum, you stay `ACTIVE` and keep earning; otherwise you drop to `BELOW_MIN` and stop earning until the pool recovers.

**Can a validator take a delegator's funds?** No. Delegator principal is segregated and only ever returns to the delegator. The only delegator funds a validator receives is a delegator's own early‑exit penalty.

## Glossary

- **ELN** — Elyon Chain's native coin (gas + staking).
- **APOS** — Authorized Proof of Stake, Elyon's consensus.
- **Pool** — your own stake **+** delegators' deposits; drives your tier.
- **Tier** — pool threshold → fee‑share %, set by the admin's tier curve.
- **Staking package** — admin‑published terms (lock, min, APR) you stake through.
- **Delegator package** — terms **you** publish for delegators (rate, lock, min, penalty).
- **Elyon code** — your public validator code (e.g. `VAL‑ABC123`) for delegators.

## What's intentionally not here

To keep validators safe and the network clean, this distribution **omits all admin functionality**:

- ❌ `/admin` and `/setup` routes + the admin wizard page
- ❌ Admin API: approve/reject/suspend validators, set tiers, create/convert a chain, deploy/manage the registry, withdraw admin fees (all return `404`)
- ❌ Admin tabs in the panel (Validators, Tier Curve, Faucet, LB Weights)
- ❌ The faucet service

If you operate the **admin** node, use the admin distribution instead.

## License

Released under the [MIT License](LICENSE).

---

<div align="center">
Made for the Elyon Chain community. Run a node, grow your pool, earn your share. 🟢
</div>
