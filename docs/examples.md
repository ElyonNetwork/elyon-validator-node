# Example bots

The [`examples/`](../examples) folder has a small, runnable bot in nine languages. They all do the same
thing against a running `elyon serve`:

1. `GET /v1/status` — print the wallet address and its ELN / wUSDT balances;
2. `GET /v1/futures/price?market=BTC` — print the last BTC price;
3. `GET /v1/portfolio` — print the equity estimate;
4. only with `ELYON_TRADE=1`: open a long BTC position (1 wUSDT margin, 2×, stop loss 10 % below), retrying
   once on `QUOTE_EXPIRED`, then close it;
5. `POST /v1/batch` — several read-only commands in one request.

All of them read `ELYON_TOKEN` (required) and `ELYON_URL` (default `http://127.0.0.1:7457`), and stop with
the elyon error code and message when a call fails. Each was run against the live daemon on 2026-11-13.

| Language | File | Run |
|---|---|---|
| Python 3.8+ (standard library) | `examples/python/bot.py` | `python3 bot.py` |
| Node.js 18+ (built-in fetch) | `examples/node/bot.mjs` | `node bot.mjs` |
| Go 1.22+ (standard library) | `examples/go/main.go` | `go run .` |
| C# / .NET 8+ | `examples/csharp/Program.cs` | `dotnet run` |
| Java 11+ (java.net.http) | `examples/java/ElyonBot.java` | `java ElyonBot.java` |
| PHP 8 (curl extension) | `examples/php/bot.php` | `php bot.php` |
| Rust (ureq + serde_json) | `examples/rust/src/main.rs` | `cargo run` |
| Bash + curl + jq | `examples/curl/bot.sh` | `./bot.sh` |
| PowerShell 7+ | `examples/powershell/bot.ps1` | `./bot.ps1` |

```sh
elyon serve                                 # terminal 1 (asks for the password once)
export ELYON_TOKEN=$(elyon api-token show)  # terminal 2
python3 examples/python/bot.py
```
Output of the read-only run on 2026-11-13 (after the test funds had been returned, hence the empty wallet):
```text
wallet 0xe60Cb95FbB1647AfB982C4f2c5D19F475fd7ebD7 | ELN 0.000000000000147 | wUSDT 0
BTC last price 68457.1
equity estimate 0.00 wUSDT
batch step 0 futures.price ok
batch step 1 spot.price ok
batch step 2 futures.positions ok
```

## Patterns worth copying

**Retry only what is safe to retry.** `QUOTE_EXPIRED`, `PRICE_FEED_UNAVAILABLE`, `POOL_NOT_READY`,
`PRICE_MOVED`, `RPC_UNAVAILABLE`, `DEX_API_UNAVAILABLE` and `RATE_LIMITED` mean nothing was executed: retry
after a short pause. On `TRANSACTION_PENDING`, check the hash with `GET /v1/tx?hash=…` before sending again.

**Amounts as strings.** Send `"margin": "10.5"` rather than `10.5`; elyon parses decimals exactly.

**Protect the stop.** Open with `stop_loss` (and `take_profit`) in the same call, or use
`"risk": "5", "stop_loss": "…"` to let elyon size the position so a stop-out loses about 5 wUSDT.

**One call for an emergency exit.** [`examples/batch/emergency-exit.json`](../examples/batch/emergency-exit.json):
```json
{"stop_on_error": false, "commands": [{"command": "futures cancel-all"}, {"command": "futures close-all"}, {"command": "portfolio"}]}
```
```sh
elyon run examples/batch/emergency-exit.json        # or POST it to /v1/batch
```

**Use the CLI from any language without HTTP.** Spawn `elyon --json <command>`, read stdout, check the exit
code (0 = ok). While `elyon serve` runs, signing commands are executed by it, so no password prompt appears:
```python
import json, subprocess
out = subprocess.run(["elyon", "--json", "futures", "positions"], capture_output=True, text=True)
answer = json.loads(out.stdout)
print(answer["ok"], answer.get("result"))
```
