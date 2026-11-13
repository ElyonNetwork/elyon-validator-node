# elyon — command-line trading client for the Elyon DEX

`elyon` lets your trading bot use **every trading feature of the [Elyon DEX](https://dex.elyon.network)**
(spot and perpetual futures on ElyonChain, chain id 55452773) without a browser and without a wallet
pop-up. It runs on your own computer next to your bot (Windows, macOS, Linux or Docker), keeps the trading
key **encrypted on that computer only**, and signs the transactions itself.

- **No graphical interface.** Everything is a command in plain English:
  `elyon futures open long BTC --margin 10 --leverage 5 --stop-loss 62000`.
- **Two ways to send commands, same names and results:**
  1. one-shot command line: `elyon <command>` (friendly text, or `--json` for programs; exit code 0/1);
  2. a local HTTP+JSON API: `elyon serve` unlocks the key once and listens on `http://127.0.0.1:7457`
     so a bot in **any language** (Python, Node.js, Go, C#, Java, PHP, Rust, curl, PowerShell…) can call
     `POST /v1/futures/open` with a JSON body.
- **Aggregate commands:** a batch of commands in one call (`elyon run batch.json`, `POST /v1/batch`),
  `futures close-all`, `futures cancel-all` and a one-call `portfolio` snapshot.
- **Open source, no telemetry.** It only talks to the Elyon RPC (`https://mainnet.elyon.network/rpc`) and the
  DEX public API (`https://dex.elyon.network`). Elyon never sees your key or your password.

> Status: 0.1.0 — verified end to end on ElyonChain mainnet on 2026-11-13 (46 transactions: spot buy/sell/swap,
> futures open/TP-SL/partial close/close, limit orders, close-all/cancel-all, batches, gas purchase, wrap,
> guarded transfers). See [docs/transcripts](docs/transcripts).

## Why it is safe

| Concern | How elyon handles it |
|---|---|
| Who has the key? | Only your computer. It is generated there (24-word BIP-39 phrase from the operating system's randomness) and **never sent anywhere**. |
| Key at rest | `wallet.json`, mode 0600, encrypted with **AES-256-GCM** under a key derived from your password with **scrypt (N=2^18, r=8, p=1)**. Settings that matter for security (password age, backup state, approved addresses, daily limits) are signed with a key derived from the private key, so editing the file is detected. |
| Stolen computer / copied files | Without the password nobody can use the key or send commands that sign: the daemon is not running, or is locked, and the file is encrypted. Details in [SECURITY.md](SECURITY.md). |
| Password | At least 12 characters; expires after 90 days by default (warning 14 days before; after expiry the wallet refuses to unlock until `elyon password change`). Five wrong passwords block password checks for 15 minutes. |
| Recovery | The 24 words are shown **once**, followed by a short quiz; after that `wallet backup` refuses to show them again unless you pass an explicit, scary flag and the password. `wallet restore` moves the wallet to a new computer (the phrase also imports into MetaMask, path m/44'/60'/0'/0/0). |
| Local API | Binds to 127.0.0.1 by default; random 256-bit token in its own 0600 file, checked in constant time; failed tokens and all requests are rate limited; Host/Origin checks stop browser attacks (DNS rebinding); optional `--allow-ip` for Docker; optional idle auto-lock; every command is written to `audit.log` (never secrets). |
| Money leaving the wallet | Trading commands can only pay **to the wallet itself** (swap outputs, futures payouts). `wallet send` needs the password in that request **or** a destination you approved with the password, and respects optional daily limits. |
| Unknown contracts | The Elyon contract addresses are compiled in and cross-checked against the DEX API; if the exchange ever reports a different contract, elyon refuses to approve or call it. Token tickers are cross-checked against a built-in list of the ~1,400 wrapped tokens; pools are verified by their CREATE2 address; signed futures prices are verified against the feeder registered on-chain. |

## Install

Download the binary for your system from [dex.elyon.network/bots](https://dex.elyon.network/bots#download) or the GitHub release
(or build it, see below) and check its checksum:

| System | File |
|---|---|
| Windows (64-bit) | `elyon-0.1.0-windows-amd64.exe` |
| macOS Apple Silicon | `elyon-0.1.0-darwin-arm64` |
| macOS Intel | `elyon-0.1.0-darwin-amd64` |
| Linux x86-64 | `elyon-0.1.0-linux-amd64` |
| Linux ARM64 (Raspberry Pi 4/5, Graviton) | `elyon-0.1.0-linux-arm64` |

Step-by-step guides: [Windows](docs/install-windows.md) · [macOS](docs/install-macos.md) ·
[Linux](docs/install-linux.md) · [Docker](docs/install-docker.md).

Build from source (Go 1.26 or newer) — clone the repository or download `elyon-bot-0.1.0-source.tar.gz` from
[dex.elyon.network/bots](https://dex.elyon.network/bots#download):

```sh
git clone https://github.com/ElyonNetwork/elyon-bot && cd elyon-bot
go test ./...                  # unit tests
scripts/build.sh               # dist/ with all five binaries and SHA256SUMS
```

The build is reproducible (`CGO_ENABLED=0`, `-trimpath`, no build id, Go toolchain pinned to 1.27.4 in `go.mod`), so
you can compare your own `SHA256SUMS` with the published one. Build the release itself: the tag
(`git checkout v0.1.0`) or the unpacked source archive, which carries the release commit in its `RELEASE` file.

## Quick start

```sh
elyon setup                 # create (or restore) the wallet, choose a password, write down the 24 words
elyon wallet address        # → send wUSDT (for trading) and ~0.1–0.3 ELN (for gas) here from your DEX wallet
elyon wallet balance
elyon futures price BTC
elyon futures open long BTC --margin 10 --leverage 5 --take-profit 80000 --stop-loss 62000
elyon futures positions
elyon futures close 6253401 --percent 50
elyon spot buy BTC --spend 100
elyon portfolio
```

How to get funds in: deposit USDT on the DEX website as usual to receive wUSDT, then send wUSDT and a little
ELN from your DEX wallet to the address shown by `elyon wallet address`. If you run out of gas later,
`elyon gas buy 0.5` buys ELN for network fees at the fixed price, paid in wUSDT (exactly the website's
"Buy ELN for gas").

### For bots: the local API

```sh
elyon serve                 # asks for the password once, then serves http://127.0.0.1:7457
elyon api-token show        # the secret token your bot sends
```

```sh
TOKEN=$(elyon api-token show)
curl -s -X POST http://127.0.0.1:7457/v1/futures/open \
  -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  -d '{"side":"long","market":"BTC","margin":"10","leverage":5,"stop_loss":"62000"}'
```

Every CLI command is available at `/v1/<command words>`; read-only ones also with `GET`. While the daemon
runs, one-shot `elyon …` commands are sent through it automatically (no password prompt).
Unattended restarts (servers, Docker) can read the password from `ELYON_PASSWORD_FILE` — an explicit,
documented opt-in with a warning; see [SECURITY.md](SECURITY.md#unattended-mode).

## Commands

| Group | Commands |
|---|---|
| Start | `setup`, `status`, `portfolio`, `version`, `help` |
| Wallet | `wallet create`, `wallet restore`, `wallet address`, `wallet backup`, `wallet balance [--all]`, `wallet send <amount\|all> <TOKEN> to <address>`, `wallet allow <address>`, `wallet disallow`, `wallet allowed`, `wallet limit <amount\|none> <TOKEN>`, `wallet limits`, `password change`, `password policy`, `api-token show\|rotate`, `config show` |
| Spot | `spot markets [--search]`, `spot price`, `spot quote`, `spot buy <MARKET> --spend <wUSDT>`, `spot buy <amount> <MARKET>`, `spot sell <amount\|all> <MARKET>`, `spot swap <amount> <TOKEN> to <TOKEN>` |
| Futures | `futures markets`, `futures price`, `futures funding`, `futures open long\|short`, `futures close [--percent]`, `futures close-all`, `futures set-tp-sl`, `futures positions`, `futures limit long\|short`, `futures orders`, `futures cancel`, `futures cancel-all`, `futures history` |
| Gas & wrapping | `gas price`, `gas buy`, `wrap`, `unwrap` |
| Automation | `serve`, `unlock`, `lock`, `run <batch.json>`, `tx <hash>`, `commands` |

Full reference with examples and real output: [docs/commands.md](docs/commands.md).
HTTP API reference: [docs/http-api.md](docs/http-api.md). Sample bots in Python, JavaScript (Node.js), Go, C#, Java,
PHP, Rust, Ruby, PowerShell, Bash and the Windows Command Prompt: [examples/](examples), with the complete code and
how to run it on every system in [docs/examples.md](docs/examples.md).

## What the client mirrors from the website

- **Spot** is the website's market-page swap: wrapped tokens against wUSDT in the canonical Uniswap V2 pools
  (router `0x234F…9816`), the order waits (up to 45 s) until the pool is within 0.10 % of the global price,
  0.5 % default slippage (max 5 %), 120 s deadline, exact approvals, hard stop at 15 % price impact. Swaps
  between two tokens route through the wUSDT hub. **ELN is not tradable on ElyonDex until its exchange
  listing** (owner decision 2026-11-11): the client refuses ELN/WELN trades exactly like the website and
  points to `gas buy`. Public liquidity provision was retired on the website on 2026-10-08, so the client
  does not offer add/remove liquidity either.
- **Futures** use the same contracts as the website: positions open through the TP/SL router
  `ElyonPerpTriggersV3` on `ElyonPerpMarketV3` (isolated margin), limit orders through
  `ElyonPerpLimitRouter`; prices are the exchange's signed "last" quote from `/api/futures/quote`, checked
  for contract, market, symbol, age (20 s) and feeder signature before use; fees, minimum margin (1 wUSDT),
  safe leverage, take-profit / stop-loss rules (including the 0.05 % liquidation band), limit price side
  rules, sizing by margin / size / quantity / risk, and approvals (margin + fee + fee/50, or opt-in unlimited)
  all follow the website's order panel.

## Files (the elyon home)

`%APPDATA%\Elyon` (Windows), `~/Library/Application Support/Elyon` (macOS), `~/.config/elyon` (Linux),
`/data` (Docker); override with `--home <folder>` or `ELYON_HOME`.

| File | Content |
|---|---|
| `wallet.json` | encrypted key + signed settings (0600) |
| `api-token` | the local API token (0600) |
| `config.json` | optional settings (RPC/API URLs, listen address, slippage, auto-lock…) |
| `audit.log` | one JSON line per command, without secrets (0600, rotated at 10 MB) |
| `transfers.json` | recent transfers, for the daily limits |

## License

MIT — see [LICENSE](LICENSE). Changes: [CHANGELOG.md](CHANGELOG.md). Security model and reporting:
[SECURITY.md](SECURITY.md).
