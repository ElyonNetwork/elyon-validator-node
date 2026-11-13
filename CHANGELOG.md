# Changelog

All notable changes to elyon-bot. Versions follow [Semantic Versioning](https://semver.org/).

## [0.1.1] — 2026-11-13

Security update of 0.1.0; no change in behaviour.

- Dependency: `github.com/gorilla/websocket` v1.5.0 → v1.5.3 for GO-2026-6278 (weak random mask key in WebSocket
  client frames). elyon reaches ElyonChain over HTTPS by default and only uses WebSocket when you configure a `ws://`
  or `wss://` RPC address; even then the mask key protects proxies against crafted frames and carries no secret.
  `govulncheck ./...` now reports no vulnerabilities. The 0.1.0 binaries keep v1.5.0 (their tag is immutable).
- Release tag `elyon-bot-v0.1.1`; rebuild it byte for byte with `scripts/release-build.sh` as described in the README.

## 0.1.0 release build — 2026-11-13

The published 0.1.0 binaries are built from the tag `elyon-bot-v0.1.0` of
[ElyonNetwork/elyon-validator-node](https://github.com/ElyonNetwork/elyon-validator-node), where this client is
published in the `elyon-bot/` folder. The program code is the same as in the first
build; only how it is built and documented changed:

- Guides with screenshots for Windows, macOS, Linux and Docker; quick start, funding, backup and restore,
  troubleshooting.
- `docs/examples.md`: the complete code of every example with install and run steps per system, a step-by-step
  Python-on-Windows walkthrough, the command-line route, batch files and bots in their own Docker container
  (generated from `examples/` by `scripts/gen-examples-doc.py`).
- New examples: Ruby, and the Windows Command Prompt (`curl.exe`, read-only).
- Reproducible release build: `scripts/release-build.sh` runs `scripts/build.sh` (now with `-buildvcs=false`) in
  `golang:1.27.4-alpine`, so the release tag and the source archive (whose `RELEASE` file names the release commit)
  rebuild the published binaries byte for byte on any machine with Docker. The Docker image built from the
  `Dockerfile` contains exactly the published Linux x86-64 binary.

## [0.1.0] — 2026-11-13

First release.

### Wallet and security
- `setup`, `wallet create` (24-word BIP-39 phrase, MetaMask-compatible path m/44'/60'/0'/0/0), `wallet restore`
  (phrase of 12–24 words, or private key; hidden prompt or standard input).
- Encrypted keystore: scrypt (N=2^18, r=8, p=1) + AES-256-GCM, file mode 0600, security settings signed
  with HMAC-SHA256 (tamper detection), atomic writes.
- Password policy: 12+ characters, 90-day maximum age (configurable 7–365), warning 14 days ahead, refusal
  to unlock after expiry until `password change`; 5 wrong attempts block password checks for 15 minutes.
- One-time reveal of the recovery phrase with a 3-word quiz; later reveals need
  `--show-again-i-understand-the-risk`, a typed confirmation and the password.
- Guarded `wallet send`: password in the request or an approved destination (`wallet allow`, password
  required), optional per-token daily limits, refusal of contract/zero/self destinations.
- Opt-in unattended mode with `ELYON_PASSWORD_FILE` / `ELYON_PASSWORD` (always warned).

- Hidden password prompts: echo off before the prompt is printed, type-ahead discarded (like readpassphrase),
  terminal restored on Ctrl+C, and every prompt shown before any network activity. Fixes a report that
  `elyon serve` showed the password in clear when it was typed while the client was still connecting (the
  prompt used to appear only after an RPC round-trip, and text typed before it was echoed by the terminal and
  then accepted as the password). Regression tests run the CLI on a pseudo-terminal.

### Trading (mirrors dex.elyon.network)
- Spot: `markets`, `price`, `quote`, `buy` (spend wUSDT or exact amount), `sell` (amount or all), `swap`
  (two tokens through the wUSDT hub). Pool-sync wait, 0.5 % default slippage, 15 % impact limit, exact
  approvals, CREATE2 pool verification, ELN trading lock like the website.
- Futures: `markets`, `price`, `funding`, `open` (margin / size / quantity / risk sizing, TP/SL),
  `close` (whole or percent), `close-all`, `set-tp-sl` (set / change / remove), `positions` (live PnL and
  exact payout from `previewClose`), `limit`, `orders`, `cancel`, `cancel-all`, `history`.
  Signed quotes verified (contract, market, symbol, age, on-chain feeder).
- Gas: `gas price`, `gas buy` (ELN for gas at the fixed price, paid in wUSDT). `wrap` / `unwrap` ELN ↔ WELN.
- Aggregates: `portfolio`, `run <batch.json>` / `POST /v1/batch`, `close-all`, `cancel-all`.

### Interfaces
- One-shot CLI with friendly text or `--json` (exit code 0/1); automatic forwarding to a running daemon.
- `elyon serve`: HTTP+JSON API on 127.0.0.1:7457 with bearer token (constant-time), Host/Origin checks,
  `--allow-ip`, rate limits, idle auto-lock, lock/unlock endpoints, optional TLS, audit log.
- Example bots in Python, Node.js, Go, C#, Java, PHP, Rust, curl/bash and PowerShell.

### Build
- Static binaries for Windows amd64, macOS amd64/arm64, Linux amd64/arm64 with SHA256SUMS; Dockerfile
  (non-root, data volume).
