#!/usr/bin/env python3
"""Writes docs/examples.md: the guide text below plus the COMPLETE code of every example in examples/, so the page
(also published on dex.elyon.network/bots/examples) always shows exactly the code in this repository.
Run after changing an example:  python3 scripts/gen-examples-doc.py"""
import pathlib, re

ROOT = pathlib.Path(__file__).resolve().parent.parent

def code(path: str, lang: str) -> str:
    text = (ROOT / path).read_text(encoding="utf-8").replace("\r\n", "\n").rstrip("\n")
    return f"`{path}`\n\n```{lang}\n{text}\n```"

TEMPLATE = r'''# Code examples: connect your bot in any language

Your bot does not need any Elyon library. It talks to `elyon` on its own computer, and elyon does the signing, the
contract calls and the waiting. This page shows the complete code of a small, working bot in many languages, and
exactly how to run it on Windows, macOS, Linux and Docker.

**Jump to:** [Python on Windows, step by step](#step-by-step-a-python-bot-on-windows) ·
[Python](#python) · [JavaScript and Node.js](#javascript-and-nodejs) · [Go](#go) · [C# and .NET](#c-and-net) ·
[Java](#java) · [PHP](#php) · [Rust](#rust) · [Ruby](#ruby) · [PowerShell](#powershell) ·
[Windows Command Prompt](#windows-command-prompt-cmd) · [Bash, curl and jq](#bash-curl-and-jq) ·
[Command line from any language](#the-command-line-from-any-language) ·
[Aggregate commands](#aggregate-commands-batch-files) · [Docker](#run-any-example-in-docker)

## How a bot talks to elyon

| Way | Best for | How |
|---|---|---|
| **Local HTTP API** | bots that run all the time, in any language | Start `elyon serve` once. The bot sends JSON to `http://127.0.0.1:7457` with a secret token. |
| **Command line with `--json`** | scripts, scheduled jobs, any language that can start a program | The bot runs `elyon --json <command>` and reads the JSON it prints. |
| **Batch files** (aggregate commands) | several commands in one go, for example an emergency exit | `elyon run file.json`, or `POST /v1/batch` with the same JSON. |

All three run the same commands and give the same kind of answer:

```json
{"ok": true, "result": {"...": "..."}}
{"ok": false, "error": {"code": "QUOTE_EXPIRED", "message": "...", "hint": "..."}}
```

Your bot checks `ok`. When it is `false`, `error.code` says what happened in a stable code your bot can react to
(see [Patterns worth copying](#patterns-worth-copying) and the [error codes](http-api.md#error-codes)).

## Before you start: run elyon and get the token

Install elyon and create your wallet first ([Windows](install-windows.md), [macOS](install-macos.md),
[Linux](install-linux.md), [Docker](install-docker.md)). Then every example needs two things: the local API running,
and the API token in the environment variable `ELYON_TOKEN`.

### Windows (PowerShell)

```powershell
# Window 1: start the local API, type the wallet password once, and leave this window open
elyon serve

# Window 2: give the token to programs started from this window, then start your bot here
$env:ELYON_TOKEN = (elyon api-token show)
```

In the Command Prompt (cmd.exe) the second step is:
`for /f "delims=" %t in ('elyon api-token show') do set ELYON_TOKEN=%t`

### macOS and Linux

```sh
# Terminal 1: start the local API, type the wallet password once, and leave it open
elyon serve

# Terminal 2: give the token to programs started from this terminal, then start your bot here
export ELYON_TOKEN=$(elyon api-token show)
```

### Docker

```sh
export ELYON_TOKEN=$(docker exec elyon elyon api-token show 2>/dev/null)
```

A bot on the same machine uses the published port `http://127.0.0.1:7457`. A bot in its own container uses the
container name instead, see [Run any example in Docker](#run-any-example-in-docker).

The examples read `ELYON_URL` too (default `http://127.0.0.1:7457`). Set it only if you changed the address.

> **Keep the token secret.** It lets programs on this computer trade with your wallet. Sending funds out of the
> wallet also needs your password or an address you approved beforehand. Do not write the token into code you share
> or upload. Read it from `ELYON_TOKEN` or from
> elyon's token file (below). Replace it whenever you like with `elyon api-token rotate`.

### Or let the bot read the token file

elyon keeps the token in the file `api-token` in its data folder. It is readable only by your user, so a bot that
runs as you can read it directly. This is handy for scheduled tasks and services, where setting `ELYON_TOKEN` is
awkward:

| System | Token file |
|---|---|
| Windows | `%APPDATA%\Elyon\api-token` |
| macOS | `~/Library/Application Support/Elyon/api-token` |
| Linux | `~/.config/elyon/api-token` |
| Docker | `/data/api-token` inside the elyon container |

In Python:

```python
import os, pathlib, sys

def token_file():
    if sys.platform == "win32":
        return pathlib.Path(os.environ["APPDATA"]) / "Elyon" / "api-token"
    if sys.platform == "darwin":
        return pathlib.Path.home() / "Library" / "Application Support" / "Elyon" / "api-token"
    return pathlib.Path(os.environ.get("XDG_CONFIG_HOME") or pathlib.Path.home() / ".config") / "elyon" / "api-token"

TOKEN = os.environ.get("ELYON_TOKEN") or token_file().read_text().strip()
```

## What every example does

All examples do the same thing, so you can compare them line by line:

1. `GET /v1/status`: print the wallet address and its ELN and wUSDT balances.
2. `GET /v1/futures/price?market=BTC`: print the last BTC price.
3. `GET /v1/portfolio`: print the equity estimate.
4. Only when `ELYON_TRADE=1` is set: open a long BTC position (1 wUSDT margin, 2×, stop loss 10 % below), retry
   once on `QUOTE_EXPIRED`, then close it again. This is a real trade that costs a few cents in fees.
5. `POST /v1/batch`: several read-only commands in one request.

Without `ELYON_TRADE=1` they only read. When a call fails they stop and print elyon's error code and message.
Every example was run against a live elyon on ElyonChain mainnet (2026-11-13). The Command Prompt file uses the same
requests as the curl example.

## Step by step: a Python bot on Windows

The whole path for a bot written in Python on Windows. Other languages and systems work the same way. Only the
install and run commands differ, and the sections below list them.

#### 1. Install elyon and create the wallet

Follow [Install on Windows](install-windows.md) up to "Fund it". At the end, `elyon version` works in PowerShell and
your wallet holds wUSDT and a little ELN for fees ([Fund your bot wallet](funding.md)).

#### 2. Install Python

In PowerShell:

```powershell
winget install Python.Python.3.13
```

Or download it from python.org and tick **Add python.exe to PATH** in the installer. Close PowerShell, open it again
and check with `python --version` (3.8 or newer).

#### 3. Save the bot

Create the folder `C:\bots\elyon`. Open Notepad, paste the [Python code](#python) from this page, and save it as
`C:\bots\elyon\bot.py`. Choose **Save as type: All files**, otherwise Notepad saves `bot.py.txt`.

#### 4. Start elyon

In a first PowerShell window, start the local API, type your wallet password once, and leave the window open:

```powershell
elyon serve
```

To have it start by itself after a restart, see
[Start the API automatically](install-windows.md#start-the-api-automatically-optional).

#### 5. Run the bot

In a second PowerShell window:

```powershell
cd C:\bots\elyon
$env:ELYON_TOKEN = (elyon api-token show)
python bot.py
```

The output looks like this (this run used an empty test wallet, hence the zero balances):

```text
wallet 0xe60Cb95FbB1647AfB982C4f2c5D19F475fd7ebD7 | ELN 0.000000000000147 | wUSDT 0
BTC last price 68457.1
equity estimate 0.00 wUSDT
batch step 0 futures.price ok
batch step 1 spot.price ok
batch step 2 futures.positions ok
```

#### 6. Make it trade

The example only reads unless you allow it to trade. This opens a long BTC position with 1 wUSDT margin at 2× and
closes it again right away:

```powershell
$env:ELYON_TRADE = "1"; python bot.py
Remove-Item Env:ELYON_TRADE
```

#### 7. Write your own strategy

Keep the `call` and `must` functions and replace the middle part with your logic. `call("/v1/...")` reads,
`call("/v1/...", {...})` sends a command. Every command, its path and its fields are in the
[Local HTTP API](http-api.md) reference and in `elyon commands`. For example:

```python
must(call("/v1/spot/buy", {"market": "ETH", "spend": "25"}))

eth = must(call("/v1/futures/price?market=ETH"))["market"]["last"]
must(call("/v1/futures/open", {"side": "short", "market": "ETH", "margin": "10", "leverage": 5,
                               "take_profit": str(round(eth * 0.95)), "stop_loss": str(round(eth * 1.03))}))

for p in must(call("/v1/futures/positions"))["positions"]:
    print(p["id"], p["market"], p["side"], p["unrealized_pnl"])
```

#### 8. Run it on a schedule

Use the Windows **Task Scheduler**: create a task, action **Start a program**, program: the path that
`(Get-Command python).Source` prints, arguments: `bot.py`, start in: `C:\bots\elyon`. Let the bot
[read the token file](#or-let-the-bot-read-the-token-file) so the task does not need `ELYON_TOKEN`. `elyon serve`
must be running.

## Python

| | Windows | macOS | Linux |
|---|---|---|---|
| Install | `winget install Python.Python.3.13` | `brew install python` | `sudo apt install python3` |
| Run | `python bot.py` | `python3 bot.py` | `python3 bot.py` |

Python 3.8 or newer, standard library only (no `pip install`).

@@examples/python/bot.py python@@

## JavaScript and Node.js

| | Windows | macOS | Linux |
|---|---|---|---|
| Install | `winget install OpenJS.NodeJS.LTS` | `brew install node` | from nodejs.org (distribution packages are often too old) |
| Run | `node bot.mjs` | `node bot.mjs` | `node bot.mjs` |

Node.js 18 or newer (built-in `fetch`, no `npm install`).

@@examples/node/bot.mjs javascript@@

## Go

| | Windows | macOS | Linux |
|---|---|---|---|
| Install | `winget install GoLang.Go` | `brew install go` | from go.dev/dl (distribution packages are often too old) |
| Run | `go run .` | `go run .` | `go run .` |

Go 1.22 or newer, standard library only. Put both files in one folder and run `go run .` there.

@@examples/go/go.mod text@@

@@examples/go/main.go go@@

## C# and .NET

| | Windows | macOS | Linux |
|---|---|---|---|
| Install | `winget install Microsoft.DotNet.SDK.8` | `brew install --cask dotnet-sdk` | `sudo apt install dotnet-sdk-8.0` |
| Run | `dotnet run` | `dotnet run` | `dotnet run` |

.NET 8 or newer, no packages. Put both files in one folder and run `dotnet run` there.

@@examples/csharp/ElyonBot.csproj xml@@

@@examples/csharp/Program.cs csharp@@

## Java

| | Windows | macOS | Linux |
|---|---|---|---|
| Install | `winget install EclipseAdoptium.Temurin.21.JDK` | Temurin 21 from adoptium.net | `sudo apt install openjdk-21-jdk-headless` |
| Run | `java ElyonBot.java` | `java ElyonBot.java` | `java ElyonBot.java` |

Java 11 or newer runs the single file directly, without a build step. A real bot would read the JSON with a library
such as Jackson or Gson; this example uses small helpers so it runs with a bare JDK.

@@examples/java/ElyonBot.java java@@

## PHP

| | Windows | macOS | Linux |
|---|---|---|---|
| Install | `winget install PHP.PHP.8.4` | `brew install php` | `sudo apt install php-cli php-curl` |
| Run | `php bot.php` | `php bot.php` | `php bot.php` |

PHP 8 with the curl extension. On Windows, turn it on once: `php --ini` shows PHP's folder. Copy
`php.ini-production` there to `php.ini`, and in `php.ini` remove the `;` in front of `extension_dir = "ext"` and
`extension=curl`.

@@examples/php/bot.php php@@

## Rust

| | Windows | macOS | Linux |
|---|---|---|---|
| Install | `winget install Rustlang.Rustup` | rustup.rs | rustup.rs |
| Run | `cargo run` | `cargo run` | `cargo run` |

Uses the crates `ureq` and `serde_json` (cargo downloads them on the first run). Put `Cargo.toml` in a folder and
`main.rs` in its `src` subfolder.

@@examples/rust/Cargo.toml toml@@

@@examples/rust/src/main.rs rust@@

## Ruby

| | Windows | macOS | Linux |
|---|---|---|---|
| Install | `winget install RubyInstallerTeam.Ruby.3.3` | `brew install ruby` | `sudo apt install ruby` |
| Run | `ruby bot.rb` | `ruby bot.rb` | `ruby bot.rb` |

Ruby 3, standard library only.

@@examples/ruby/bot.rb ruby@@

## PowerShell

| | Windows | macOS | Linux |
|---|---|---|---|
| Install | `winget install Microsoft.PowerShell` | `brew install --cask powershell` | see Microsoft's "Install PowerShell on Linux" |
| Run | `pwsh .\bot.ps1` | `pwsh ./bot.ps1` | `pwsh ./bot.ps1` |

Needs PowerShell 7 or newer (`pwsh`). The older Windows PowerShell 5.1 does not have `-SkipHttpErrorCheck`. If
Windows refuses to run a downloaded script, run `Unblock-File .\bot.ps1` once.

@@examples/powershell/bot.ps1 powershell@@

## Windows Command Prompt (cmd)

Nothing to install: `curl.exe` is part of Windows 10 and 11. Put the three files in one folder and run `bot.cmd`.
Reading values out of the JSON answers is clumsy in cmd, so this example only reads. For a bot that makes decisions,
use PowerShell or one of the languages above.

@@examples/windows-cmd/bot.cmd bat@@

@@examples/windows-cmd/read-only.json json@@

@@examples/windows-cmd/order.json json@@

## Bash, curl and jq

| | Windows | macOS | Linux |
|---|---|---|---|
| Install | use Git Bash or WSL (or the PowerShell example) | `brew install jq` | `sudo apt install curl jq` |
| Run | `bash bot.sh` | `bash bot.sh` | `bash bot.sh` |

@@examples/curl/bot.sh bash@@

## The command line from any language

Any language that can start a program can use elyon without HTTP: run `elyon --json <command>`, read standard
output, and check the exit code (0 means ok). While `elyon serve` runs, commands that sign are carried out by it, so
no password prompt appears. Without `elyon serve`, signing commands ask for the password in the terminal, which a bot
cannot answer.

Python:

```python
import json, subprocess

def elyon(*args):
    out = subprocess.run(["elyon", "--json", *args], capture_output=True, text=True)
    return json.loads(out.stdout)

answer = elyon("futures", "price", "BTC")
print(answer["result"]["market"]["last"] if answer["ok"] else answer["error"]["code"])
```

Node.js:

```javascript
import { spawnSync } from "node:child_process";

const elyon = (...args) => JSON.parse(spawnSync("elyon", ["--json", ...args], { encoding: "utf8" }).stdout);

const answer = elyon("futures", "price", "BTC");
console.log(answer.ok ? answer.result.market.last : answer.error.code);
```

PowerShell:

```powershell
$answer = elyon --json futures positions | ConvertFrom-Json
if ($answer.ok) { $answer.result.positions } else { $answer.error.code }
```

The command line takes the same commands as the API, written as words: `elyon --json futures open long BTC
--margin 10 --leverage 5 --stop-loss 60000`. The [command reference](commands.md) lists all of them.

## Aggregate commands (batch files)

A batch runs several commands in order and returns one result per step. elyon carries out the steps itself, on your
computer. Your bot sends one request, or you run one command. With `"stop_on_error": true` (the default) it stops at
the first failed step and skips the rest. With `false` it tries every step.

Run a batch file from the command line, or send the same JSON to the API:

```sh
elyon run open-and-protect.json
elyon run - < open-and-protect.json          # from standard input
curl -s -X POST http://127.0.0.1:7457/v1/batch -H "Authorization: Bearer $ELYON_TOKEN" \
  -H "Content-Type: application/json" --data-binary @open-and-protect.json
```

Emergency exit: cancel every limit order, close every position, then show what is left.

@@examples/batch/emergency-exit.json json@@

Open a protected position: check the price, open with take profit and stop loss, list the positions.

@@examples/batch/open-and-protect.json json@@

Rebalance spot: sell all ETH, buy BTC for 50 wUSDT, show the balances.

@@examples/batch/rebalance-spot.json json@@

Every command can be a step, with the same fields as its API request in `params`. The
[Local HTTP API](http-api.md) reference has the full batch format and the combined commands `portfolio`,
`futures close-all` and `futures cancel-all`.

## Run any example in Docker

When elyon runs in a container ([Install with Docker](install-docker.md)), a bot in another container reaches it
by the container name over a shared Docker network. Requests from private networks are allowed, and the token is
still required:

```sh
docker network create elyon-net                 # once
docker network connect elyon-net elyon          # the elyon container joins it
export ELYON_TOKEN=$(docker exec elyon elyon api-token show 2>/dev/null)

# run the Python example from the current folder in its own container
docker run --rm --network elyon-net -e ELYON_URL=http://elyon:7457 -e ELYON_TOKEN \
  -v "$PWD":/bot -w /bot python:3-slim python bot.py
```

`-e ELYON_TOKEN` without a value passes the variable on without writing the token into the command. The same
works for every language with its official image:

| Language | Image | Command |
|---|---|---|
| Python | `python:3-slim` | `python bot.py` |
| Node.js | `node:lts-slim` | `node bot.mjs` |
| Go | `golang:1` | `go run .` |
| C# | `mcr.microsoft.com/dotnet/sdk:8.0` | `dotnet run` |
| Java | `eclipse-temurin:21-jdk` | `java ElyonBot.java` |
| PHP | `php:8-cli` | `php bot.php` |
| Rust | `rust:1` | `cargo run` |
| Ruby | `ruby:3-slim` | `ruby bot.rb` |
| PowerShell | `mcr.microsoft.com/powershell` | `pwsh ./bot.ps1` |

In Docker Compose, put the bot next to elyon and set `ELYON_URL: http://elyon:7457`. The
[Docker guide](install-docker.md) has a complete `docker-compose.yml`.

## Patterns worth copying

**Retry only what is safe to retry.** `QUOTE_EXPIRED`, `PRICE_FEED_UNAVAILABLE`, `POOL_NOT_READY`, `PRICE_MOVED`,
`RPC_UNAVAILABLE`, `DEX_API_UNAVAILABLE` and `RATE_LIMITED` mean nothing was executed: retry after a short pause.
On `TRANSACTION_PENDING`, check the hash with `GET /v1/tx?hash=...` before sending again.

**Send amounts as strings.** Send `"margin": "10.5"` rather than `10.5`. elyon reads decimals exactly.

**Protect every position.** Open with `stop_loss` (and `take_profit`) in the same call, or use
`"risk": "5", "stop_loss": "..."` to let elyon size the position so a stop-out loses about 5 wUSDT.

**Keep one emergency exit ready.** The `emergency-exit.json` batch above cancels all orders and closes all positions
in one call.

**One wallet, one elyon.** Several bots can share one running elyon. Do not run two elyon instances with the same
wallet at the same time (`NONCE_CONFLICT`).

**Test small.** A bot does exactly what it is told. Start with the minimum margin of 1 wUSDT.

## Other languages

Any language that can send an HTTP request or start a program works the same way: Kotlin, Swift, Dart, Lua, R,
Perl, Excel VBA and others. Three rules:

1. Send `Authorization: Bearer <token>` with every request to `http://127.0.0.1:7457`.
2. Read with `GET` and query parameters, and act with `POST` and a JSON body (`Content-Type: application/json`).
3. Check `ok` in the answer. When it is `false`, use `error.code`.

The [Local HTTP API](http-api.md) reference lists every path and field, and `elyon commands --json` prints the same
list for programs.
'''

def fill(m: re.Match) -> str:
    path, lang = m.group(1), m.group(2)
    return code(path, lang)

out = re.sub(r"@@(\S+) (\S+)@@", fill, TEMPLATE)
(ROOT / "docs" / "examples.md").write_text(out, encoding="utf-8")
print("docs/examples.md:", len(out.splitlines()), "lines")
