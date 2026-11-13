# elyon HTTP API

`elyon serve` unlocks the key once and serves a JSON API so a bot written in any language can trade with a
normal HTTP request. Every command of the CLI is available with the same name and the same parameters.

```text
Base URL      http://127.0.0.1:7457            (change with --listen or "listen" in config.json)
Auth          Authorization: Bearer <token>     (elyon api-token show)
Content-Type  application/json                  (for POST bodies)
```

## Calling a command

| CLI | HTTP |
|---|---|
| `elyon futures open long BTC --margin 10 --leverage 5 --take-profit 80000` | `POST /v1/futures/open` `{"side":"long","market":"BTC","margin":"10","leverage":5,"take_profit":"80000"}` |
| `elyon futures price BTC` | `GET /v1/futures/price?market=BTC` (or `POST` with `{"market":"BTC"}`) |
| `elyon wallet balance --all` | `GET /v1/wallet/balance?all=true` |

Rules:

- Path = `/v1/` + the command words joined by `/` (`futures close-all` → `/v1/futures/close-all`).
- JSON fields = option names with underscores (`--take-profit` → `take_profit`). Positional words of the CLI
  have names too (see the table below). Unknown fields are refused (`INVALID_INPUT`), so a typo such as
  `"levrage"` never goes unnoticed.
- Values may be strings, numbers or booleans. **Send amounts and prices as strings** (`"0.1"`), so no
  floating-point rounding happens in your language; elyon parses them exactly.
- Read-only commands accept `GET` with query parameters; commands that send transactions require `POST`.
- A command that sends transactions returns after they are mined (usually 2–6 s; up to the transaction
  timeout, 180 s by default). Use a client timeout of a few minutes.

## Answer format

Success (HTTP 200):
```json
{
  "ok": true,
  "command": "futures.open",
  "result": {
    "entry_price": "68731.100000000005820766",
    "fee_paid": "0.002",
    "leverage": 2,
    "liquidation_price": "34434.384403256812534605",
    "margin": "1",
    "market": "BTC_USDT",
    "position_id": 6255261,
    "quote_price": 68731.1,
    "side": "long",
    "size_wusdt": "2",
    "stop_loss": "62000",
    "take_profit": "75000",
    "tx": "0x58c3bf8f8266b69d5ae2a2b698d345a0aae4180e5a88c7e1f47cf971c083c490"
  },
  "text": "Opened LONG BTC 2x at 68,731.10 wUSDT\n  Position           #6255261\n  …",
  "transactions": [
    {
      "label": "approve wUSDT for the futures contract",
      "hash": "0xe5fab0cf9ca25f9c75c89aed7cf3d78dd68da60c9bd04414da721870f8a5346c",
      "block": 5904306,
      "gas_used": 29019,
      "fee_eln": "0.000058038",
      "explorer": "https://explorer.elyon.network/tx/0xe5fab0cf9ca25f9c75c89aed7cf3d78dd68da60c9bd04414da721870f8a5346c"
    },
    {
      "label": "open long BTC 2x",
      "hash": "0x58c3bf8f8266b69d5ae2a2b698d345a0aae4180e5a88c7e1f47cf971c083c490",
      "block": 5904307,
      "gas_used": 451364,
      "fee_eln": "0.000902728",
      "explorer": "https://explorer.elyon.network/tx/0x58c3bf8f8266b69d5ae2a2b698d345a0aae4180e5a88c7e1f47cf971c083c490"
    }
  ]
}
```

Error (HTTP 4xx/5xx):
```json
{
  "ok": false,
  "command": "wallet.send",
  "error": {
    "code": "TRANSFER_NOT_ALLOWED",
    "message": "Sending to 0x0E0bB1BDEc7248eBac6eFBE624ceAEd86bda3e27 needs your wallet password, because this address is not on your approved list.",
    "hint": "Give the password with this request, or approve the address once: `elyon wallet allow 0x0E0b…e27` (asks for the password)."
  }
}
```

- `result` — structured data (amounts are exact decimal strings).
- `text` — the same human-readable text the CLI prints (handy for logs).
- `warnings` — e.g. password expiring soon, recovery phrase not backed up, low ELN for gas (omitted when
  empty, like `transactions` and `error.details`).
- `transactions` — every transaction sent by the command, **also on errors** (e.g. an approval that was mined
  before the open failed).
- Branch on `error.code`, never on the message text.

## Endpoints

`needs`: *nothing* (market data), *address* (reads the wallet file), *key* (the daemon must be unlocked).

### Public and status

| Method | Path | Fields | Needs |
|---|---|---|---|
| GET | `/v1/health` | — (no token needed; answers `{"ok":true,"service":"elyon","version":"0.1.0"}`) | nothing |
| GET/POST | `/v1/status` | — | nothing |
| GET/POST | `/v1/version` | — | nothing |
| GET/POST | `/v1/commands` | — (machine-readable catalogue of every command) | nothing |
| GET/POST | `/v1/portfolio` | — | address |
| GET/POST | `/v1/tx` | `hash` | nothing |
| POST | `/v1/unlock` | `password` | nothing |
| POST | `/v1/lock` | — | nothing |
| POST | `/v1/batch` | see [Batch](#batch) | per step |

### Wallet

| Method | Path | Fields | Needs |
|---|---|---|---|
| GET/POST | `/v1/wallet/address` | — | address |
| GET/POST | `/v1/wallet/balance` | `all` (bool), `token` | address |
| POST | `/v1/wallet/send` | `amount` (number or `all`), `token`, `to`, `password` (unless `to` is approved), `allow_contract` (bool) | key |
| POST | `/v1/wallet/allow` | `address`, `label`, `password` (required) | address |
| POST | `/v1/wallet/disallow` | `address` | key |
| GET/POST | `/v1/wallet/allowed` | — | address |
| POST | `/v1/wallet/limit` | `amount` (number or `none`), `token`, `password` (required) | address |
| GET/POST | `/v1/wallet/limits` | — | address |

Not available over HTTP (terminal only, answer `403 NOT_AVAILABLE_OVER_HTTP`): `setup`, `wallet create`,
`wallet restore`, `wallet backup`, `password change`, `password policy`.

### Spot

| Method | Path | Fields | Needs |
|---|---|---|---|
| GET/POST | `/v1/spot/markets` | `search`, `limit` (default 50, 0 = all) | nothing |
| GET/POST | `/v1/spot/price` | `market` | nothing |
| GET/POST | `/v1/spot/quote` | `side` (`buy`/`sell`/`swap`), `market`, `spend`, `amount`, `from`, `to`, `slippage` | nothing |
| POST | `/v1/spot/buy` | `market`, and `spend` (wUSDT) **or** `amount` (exact token amount); `slippage` (percent, default 0.5), `max_wait` (seconds, default 45) | key |
| POST | `/v1/spot/sell` | `market`, `amount` (number or `all`), `slippage`, `max_wait` | key |
| POST | `/v1/spot/swap` | `from`, `to`, `amount` (number or `all`), `slippage`, `max_wait` | key |

Result of buy/sell/swap: `give`, `get`, `route`, `amount_in`, `amount_out`, `min_out` or `max_in`,
`price_impact_pct`, `slippage_pct`, `pool_fee_pct`, `paid`, `received`, `average_price_wusdt`, `tx`.

### Futures

| Method | Path | Fields | Needs |
|---|---|---|---|
| GET/POST | `/v1/futures/markets` | `search`, `category`, `limit` | nothing |
| GET/POST | `/v1/futures/price` | `market` | nothing |
| GET/POST | `/v1/futures/funding` | `market` | nothing |
| POST | `/v1/futures/open` | `side`, `market`, `leverage`, one of `margin` / `size` / `quantity` / `risk`, `take_profit`, `stop_loss`, `approve_unlimited` | key |
| POST | `/v1/futures/close` | `id`, `percent` (1–100, default 100) | key |
| POST | `/v1/futures/close-all` | `market` (optional) | key |
| POST | `/v1/futures/set-tp-sl` | `id`, `take_profit` (price or `none`), `stop_loss` (price or `none`) | key |
| GET/POST | `/v1/futures/positions` | `market` (optional) | address |
| POST | `/v1/futures/limit` | `side`, `market`, `price`, `leverage`, sizing as for open, `expires` (`30m`…`90d`, default `30d`), `take_profit`, `stop_loss`, `approve_unlimited` | key |
| GET/POST | `/v1/futures/orders` | `all` (bool) | address |
| POST | `/v1/futures/cancel` | `id` | key |
| POST | `/v1/futures/cancel-all` | `market` (optional) | key |
| GET/POST | `/v1/futures/history` | `limit` (default 20) | address |

`/v1/futures/positions` result: `{"count": 1, "positions": [{"id": 6255261, "market": "BTC_USDT", "side":
"long", "leverage": 2, "margin": "0.500001", "size_wusdt": "1.000001", "size_base": "0.0000145491…",
"entry_price": "68731.1", "liquidation_price": "34434.35…", "take_profit": "76000", "stop_loss": "63000",
"last_price": 68710.2, "mark_price": 68712.5, "unrealized_pnl": "-0.000304", "roe_pct": "-0.06",
"funding_owed": "0", "close_fee": "0.000999", "payout_if_closed_now": "0.498698", "liquidatable": false,
"partial_close_available": true, "held_by": "tp-sl-router", "contract": "0x8081…7bB2", "router": "0x58a9…2682",
"opened_at": "2026-11-13T16:11:29Z", "fee_ppm": 1000, "open": true}]}`

### Gas and wrapping

| Method | Path | Fields | Needs |
|---|---|---|---|
| GET/POST | `/v1/gas/price` | — | nothing |
| POST | `/v1/gas/buy` | `amount` (ELN) | key |
| POST | `/v1/wrap` | `amount` (number or `all`) | key |
| POST | `/v1/unwrap` | `amount` (number or `all`) | key |

## Batch

`POST /v1/batch` runs several commands in order in one request (the CLI equivalent is
`elyon run batch.json`, same file format).

```json
{
  "stop_on_error": true,
  "commands": [
    {"command": "futures price", "params": {"market": "BTC"}},
    {"command": "futures open", "params": {"side": "long", "market": "BTC", "margin": "1", "leverage": 2, "stop_loss": "60000"}},
    {"command": "futures positions"},
    {"command": "futures close-all", "params": {"market": "BTC"}},
    {"command": "wallet balance", "params": {"token": "wUSDT"}}
  ]
}
```

- `command` may be written `"futures open"`, `"futures.open"` or `"/v1/futures/open"`.
- `stop_on_error` (default `true`): after a failed step the remaining steps are not run (`"skipped": true`).
  With `false` every step runs.
- At most 50 steps. Terminal-only commands cannot be used. Steps run one after the other; each step that
  signs waits for its transactions.
- The answer is always HTTP 200 with `ok` = all steps succeeded:

```json
{
  "ok": true,
  "command": "batch",
  "steps": [
    {"index": 0, "command": "futures.price", "ok": true, "result": {"market": {"symbol": "BTC_USDT", "last": 68584.0, "…": "…"}}, "text": "…"},
    {"index": 1, "command": "futures.open", "ok": true, "result": {"position_id": 6255263, "…": "…"}, "transactions": [{"label": "approve wUSDT for the futures contract", "hash": "0xc4780a37…"}, {"label": "open long BTC 2x", "hash": "0xc8597fba…"}]},
    {"index": 2, "command": "futures.positions", "ok": true, "result": {"count": 1, "positions": ["…"]}},
    {"index": 3, "command": "futures.close-all", "ok": true, "result": {"closed": 1, "failed": 0, "results": ["…"]}, "transactions": [{"label": "close position #6255263", "hash": "0xae62f1e6…"}]},
    {"index": 4, "command": "wallet.balance", "ok": true, "result": {"balances": ["…"]}}
  ]
}
```

A failing step: `{"index": 2, "command": "spot.buy", "ok": false, "error": {"code": "ELN_NOT_TRADABLE",
"message": "…"}}`; following steps: `{"index": 3, "command": "futures.positions", "ok": false, "skipped": true,
"error": {"code": "SKIPPED", …}}`.

## Security of the API

- Listens on `127.0.0.1` only by default. For Docker or another interface use `--listen 0.0.0.0:7457` **with**
  `--allow-ip <ip or CIDR,…>` (e.g. `172.17.0.0/16`), and publish the port only on the host's loopback.
- Every request except `/v1/health` needs the bearer token; comparison is constant-time; 5 wrong tokens per
  client address, then one try every 12 s (`429`).
- Requests whose `Host` is not localhost (DNS rebinding) or that come from a web page of another site
  (`Origin`) are refused (`403`) when bound to loopback.
- Rate limit per client address: 20 requests/s, burst 40 (`--rate`). Body limit 256 KB.
- `--auto-lock 30m` wipes the key after 30 minutes without a command; `POST /v1/lock` wipes it at once;
  `POST /v1/unlock {"password": "…"}` unlocks again. When the password expires the daemon locks itself.
- Transfers need the password in the request or an approved destination; password checks are blocked for
  15 minutes after 5 wrong passwords.
- `--tls-cert` / `--tls-key` serve HTTPS (useful if the API must cross a network).
- Every command is appended to `audit.log` (time, client address, command, parameters with secrets
  replaced by `[redacted]`, result code, transaction hashes).

## HTTP status codes

| Status | When |
|---|---|
| 200 | success (and every batch) |
| 400 | invalid input (`INVALID_INPUT`, `UNKNOWN_MARKET`, `AMBIGUOUS_MARKET`, `INVALID_ORDER`, `LEVERAGE_TOO_HIGH`, `POSITION_TOO_LARGE`, `TAKE_PROFIT_STOP_LOSS_INVALID`, `PASSWORD_TOO_WEAK`) |
| 401 | `UNAUTHORIZED` (token), `WRONG_PASSWORD`, `PASSWORD_REQUIRED` |
| 403 | `FORBIDDEN` (address/Host/Origin), `TRANSFER_NOT_ALLOWED`, `NOT_YOURS`, `NOT_AVAILABLE_OVER_HTTP` |
| 404 | `UNKNOWN_COMMAND`, `NOT_FOUND` |
| 405 | `GET` on a command that sends transactions |
| 409 | `WALLET_LOCKED`, `WALLET_MISSING`, `PASSWORD_EXPIRED`, `WALLET_FILE_MODIFIED`, `ALREADY_CLOSED`, `NONCE_CONFLICT`, `TRANSACTION_PENDING` |
| 422 | the market or the chain refused a valid request (see codes below) |
| 429 | `RATE_LIMITED`, `TOO_MANY_PASSWORD_ATTEMPTS` (see `Retry-After`) |
| 503 | `RPC_UNAVAILABLE`, `DEX_API_UNAVAILABLE`, `PRICE_FEED_UNAVAILABLE`, `GAS_SALE_UNAVAILABLE` |

## Error codes

| Code | Meaning / what to do |
|---|---|
| `INSUFFICIENT_BALANCE` | not enough wUSDT or token (`details.needed`, `details.balance`) — send funds or lower the amount |
| `NOT_ENOUGH_ELN_FOR_GAS` | not enough ELN for the network fee — send ELN or `gas buy` |
| `MARKET_CLOSED` | the underlying market is outside its trading hours; retry when it reopens |
| `MARKET_CLOSE_ONLY` | new positions paused on this market; closing works |
| `MARKET_PAUSED` | futures or limit orders paused by the exchange |
| `QUOTE_EXPIRED` | the signed price aged out; **retry** |
| `PRICE_FEED_UNAVAILABLE` | no signed price right now; retry shortly |
| `PRICE_MOVED` | slippage exceeded or deadline passed; nothing traded; retry or raise `slippage` |
| `PRICE_IMPACT_TOO_HIGH` | above 15 %; trade less |
| `POOL_NOT_READY` | the pool did not reach the global price within `max_wait`; retry |
| `NO_ROUTE` | not enough liquidity |
| `ELN_NOT_TRADABLE` | ELN/WELN cannot be traded until its exchange listing; use `gas buy` |
| `INVALID_ORDER`, `LEVERAGE_TOO_HIGH`, `POSITION_TOO_LARGE`, `TAKE_PROFIT_STOP_LOSS_INVALID` | the order breaks a market rule (message says which) |
| `TOO_MANY_OPEN_ORDERS` | 25 open limit orders already |
| `NOT_FOUND`, `NOT_YOURS`, `ALREADY_CLOSED`, `POSITION_LIQUIDATABLE` | position/order state |
| `TRANSACTION_REVERTED` | mined but reverted (`details.reason`, `details.tx`) |
| `TRANSACTION_PENDING` | sent but not confirmed in time — check `/v1/tx` before resending |
| `NONCE_CONFLICT` | another transaction of this wallet is pending (do not use the key in two programs) |
| `TRANSFER_NOT_ALLOWED`, `DAILY_LIMIT_REACHED` | transfer protections |
| `WALLET_LOCKED`, `WRONG_PASSWORD`, `PASSWORD_REQUIRED`, `PASSWORD_EXPIRED`, `TOO_MANY_PASSWORD_ATTEMPTS`, `WALLET_FILE_MODIFIED`, `WALLET_MISSING` | wallet state |
| `CONTRACT_MISMATCH` | the exchange reports a contract this build does not trust — update elyon |
| `WRONG_CHAIN` | the RPC is not ElyonChain |
| `UNKNOWN_MARKET`, `AMBIGUOUS_MARKET`, `UNKNOWN_TOKEN`, `UNKNOWN_COMMAND`, `INVALID_INPUT` | fix the request |
| `RPC_UNAVAILABLE`, `DEX_API_UNAVAILABLE`, `RATE_LIMITED` | network trouble; retry with back-off |
| `INTERNAL_ERROR` | a bug — please report it with the audit log line |

## Minimal clients

```bash
TOKEN=$(elyon api-token show)
curl -s http://127.0.0.1:7457/v1/portfolio -H "Authorization: Bearer $TOKEN"
```

```python
import json, urllib.request
req = urllib.request.Request("http://127.0.0.1:7457/v1/futures/open",
    data=json.dumps({"side": "long", "market": "BTC", "margin": "10", "leverage": 5}).encode(),
    headers={"Authorization": "Bearer " + TOKEN, "Content-Type": "application/json"})
print(json.load(urllib.request.urlopen(req)))
```

Complete sample bots: [examples/](../examples) and [examples.md](examples.md).
