# elyon command reference

Every command works the same way from the command line and from the HTTP API (`elyon serve`):

- CLI: `elyon <command words> [positional words] [--option value]` — friendly text, or the JSON answer
  with `--json`. Exit code 0 on success, 1 on error.
- HTTP: `POST /v1/<command words separated by />` with a JSON body whose fields are the option names with
  underscores (`--take-profit` → `"take_profit"`); read-only commands also accept `GET` with query
  parameters. See [http-api.md](http-api.md).

Global options: `--json` (machine output), `--home <folder>` (another elyon home), `--no-daemon` (do not
send the command to a running daemon), `--quiet` (no progress lines), `--help` (help for one command).

Amounts are plain decimal numbers with a dot (`10`, `0.5`); they are never rounded silently — too many
decimals for a token is an error. Markets can be written `BTC`, `btc`, `BTC_USDT`, `btc-usdt` or `wBTC`.
Outputs below are real outputs from mainnet (2026-11-13); prices obviously change.

Contents: [Getting started](#getting-started) · [Wallet](#wallet) · [Spot](#spot) · [Futures](#futures) ·
[Gas and wrapping](#gas-and-wrapping) · [Daemon and automation](#daemon-and-automation) ·
[Errors](#errors)

---

## Getting started

### `elyon setup`
Guided first run (terminal only): create a new wallet or restore one, choose the password, write down the
24 words and pass the quiz, create the API token.

```text
$ elyon setup
Welcome to elyon, the command-line trading client for the Elyon DEX.
Your key is created and kept on this computer only, encrypted with your password. Elyon never sees it.
Data folder: ~/.config/elyon

  1) Create a new wallet (recommended for a trading bot)
  2) Restore a wallet from its recovery phrase or private key
Choose 1 or 2: 1
Choose a password of at least 12 characters (a short sentence is easy to remember and hard to guess).
It protects the key on this computer and must be changed every 90 days by default.
New password:
Repeat the new password:
Creating the wallet (deriving the encryption key takes a second)…

New wallet created. Address on ElyonChain:

  0xe60Cb95FbB1647AfB982C4f2c5D19F475fd7ebD7

Now write down your recovery phrase. You get it only this once.
────────────────────────────────────────────────────────────────────
  YOUR RECOVERY PHRASE (24 WORDS)
  …the 24 numbered words…
Press Enter when everything is written down (the screen will be cleared)…

Let's check your copy: type word number 3, 10 and 15 from your paper (input is hidden).
Word #3:
Word #10:
Word #15:

✓ Backup confirmed. The recovery phrase will not be shown again (unless you insist with --show-again-i-understand-the-risk).
```
Full transcript: [transcripts/01-setup.txt](transcripts/01-setup.txt).

### `elyon status`
Network, DEX API, wallet, backup state, password age, key state (daemon) and the main balances.
```text
$ elyon status
elyon 0.1.0 (commit 9f2dddfadcf8, built 2026-11-13T17:07:19+01:00, go1.27.4, linux/amd64)

  Network            ElyonChain 55452773 via https://mainnet.elyon.network/rpc — block 5,904,228 (0s ago)
  DEX API            https://dex.elyon.network — ok (96 ms)
  Wallet             0xe60Cb95FbB1647AfB982C4f2c5D19F475fd7ebD7
  Backup             recovery secret confirmed (quiz)
  Password           valid until 2027-02-11 (90 days left, max age 90 days)
  Balances           0.3 ELN (gas) · 6 wUSDT
  Home               ~/.config/elyon
```

### `elyon portfolio`
Everything in one call: balances (non-zero), open positions with PnL and the payout if closed now, open
limit orders, and totals.
```text
$ elyon portfolio
Portfolio of 0xe60Cb95FbB1647AfB982C4f2c5D19F475fd7ebD7 — 2026-11-13 16:12:03 UTC

BALANCES
  ELN                      0.29351368
  wUSDT                      4.482498

OPEN POSITIONS
  #6255262  SHORT ETH_USDT 2x  (isolated)
    Margin / size      1 wUSDT / 2 wUSDT ≈ 0.00103401 ETH
    Entry / last       1,934.21 / 1,932.86
    Liquidation        2,895.52
    PnL                0.001395 wUSDT (0.14% on margin)
    If closed now      receive ≈ 0.999397 wUSDT (after 0.001998 fee and 0 funding)
    TP / SL            none / none
  …
OPEN LIMIT ORDERS
  Order #5  SHORT BTC_USDT 2x at 90,000.00  [open]
    Margin / cost      1 wUSDT / 1.002 wUSDT when filled
    …
TOTALS (estimates, ELN excluded)
  Wallet value       4.48 wUSDT
  Margin in use      1.500001 wUSDT
  Unrealized PnL     0.000419 wUSDT
  Equity             5.98 wUSDT (wallet + positions if closed now)
  Limit orders       1.002000 wUSDT must stay in the wallet for open orders
```

### `elyon version`, `elyon help [command]`, `elyon <command> --help`
Version and build information; the list of commands; the options and examples of one command.

---

## Wallet

### `elyon wallet create`
Create a new wallet (fresh 24-word phrase) without the setup menu; shows the phrase once and runs the quiz
when in a terminal. Never overwrites an existing wallet.

### `elyon wallet restore [--private-key] [--from-stdin]`
Restore from a recovery phrase (24 words; 12/15/18/21 from other wallets also work) or, with
`--private-key`, from a 64-character private key. Typed in a hidden prompt, or piped on standard input
(`--from-stdin`, for automation together with `ELYON_PASSWORD_FILE`). Typos are reported precisely
(“word 7 is not a BIP-39 word”, “checksum is not valid”).
```text
$ elyon wallet restore --private-key --from-stdin < key.txt
Wallet restored. Address on ElyonChain:

  0x0E0bB1BDEc7248eBac6eFBE624ceAEd86bda3e27

Check that this is the address you expect before sending funds.
```

### `elyon wallet address`
```text
$ elyon wallet address
Your wallet address on ElyonChain:

  0xe60Cb95FbB1647AfB982C4f2c5D19F475fd7ebD7

Send wUSDT (for trading) and a little ELN (for network fees, 0.1 ELN is plenty) to this address.
```

### `elyon wallet backup [--show-again-i-understand-the-risk]`
Shows the recovery phrase once (terminal only, password required) and asks 3 random words. Once
confirmed, it refuses to show it again unless you pass the flag, type `SHOW` and the password.
```text
$ elyon wallet backup
Error: Your backup was already confirmed on 2026-11-13, so the recovery secret is not shown again.
  → Only if you really must see it again (for example to make a second paper copy), run: elyon wallet backup --show-again-i-understand-the-risk
```

### `elyon wallet balance [--all] [--token <TOKEN>]`
ELN, wUSDT, WELN and every Elyon wrapped token (about 1,400, read in batches straight from the chain).
Zero balances are hidden unless `--all`. Values use the pool prices.
```text
$ elyon wallet balance
Balances of 0xe60Cb95FbB1647AfB982C4f2c5D19F475fd7ebD7

  ELN                                 0.3
  wUSDT                                 6

  Total value (tokens with a market price, ELN excluded) ≈ 6.00 wUSDT
  1406 tokens checked; zero balances hidden (use --all to list them).
```

### `elyon wallet send <amount|all> <TOKEN> to <address> [--allow-contract]`
Send ELN, wUSDT, WELN, any wrapped token (`wBTC`) or any ERC-20 by address. Needs the password (the CLI
asks; over HTTP the `password` field) **unless** the destination is on your approved list; daily limits
apply in both cases. `all ELN` sends everything minus the exact network fee.
```text
$ elyon wallet send 6 wUSDT to 0xe60Cb95FbB1647AfB982C4f2c5D19F475fd7ebD7
… Sending: send 6 wUSDT…
… Confirmed: send 6 wUSDT (0x52a584b45e6f8a256e0b37b38cdbca2498f988ac2ce2c709e8e6654a1498b821)
Sent 6 wUSDT to 0xe60Cb95FbB1647AfB982C4f2c5D19F475fd7ebD7
  Transaction        0x52a584b45e6f8a256e0b37b38cdbca2498f988ac2ce2c709e8e6654a1498b821
  Network fee        0.000103082 ELN
  Explorer           https://explorer.elyon.network/tx/0x52a584b45e6f8a256e0b37b38cdbca2498f988ac2ce2c709e8e6654a1498b821
```
Refused without the password (HTTP):
```json
{"ok": false, "error": {"code": "TRANSFER_NOT_ALLOWED", "message": "Sending to 0x0E0bB1BDEc7248eBac6eFBE624ceAEd86bda3e27 needs your wallet password, because this address is not on your approved list.", "hint": "Give the password with this request, or approve the address once: `elyon wallet allow 0x0E0b…e27` (asks for the password)."}}
```

### `elyon wallet allow <address> [--label text]` · `elyon wallet disallow <address>` · `elyon wallet allowed`
Approve a destination (password required), remove one, list them.
```text
$ elyon wallet allow 0x0E0bB1BDEc7248eBac6eFBE624ceAEd86bda3e27 --label "DEX test wallet"
Approved 0x0E0bB1BDEc7248eBac6eFBE624ceAEd86bda3e27 (DEX test wallet). Transfers to it no longer need the password (daily limits still apply).
```

### `elyon wallet limit <amount|none> <TOKEN>` · `elyon wallet limits`
Cap transfers of a coin/token per rolling 24 hours (password required to set or remove).
```text
$ elyon wallet limit 1 wUSDT
Daily limit set: at most 1 wUSDT per rolling 24 hours.
$ elyon wallet send 2 wUSDT to 0x0E0bB1BDEc7248eBac6eFBE624ceAEd86bda3e27
Error: This would exceed your daily limit of 1 wUSDT: 0 wUSDT were already sent in the last 24 hours, 1 wUSDT are left.
  → Wait, or change the limit with `elyon wallet limit <amount> wUSDT` (asks for the password).
```

### `elyon password change` · `elyon password policy --max-age-days N`
Change the password (old password required, also after expiry); set how long passwords stay valid
(7–365 days, default 90). Terminal only.

### `elyon api-token show` · `elyon api-token rotate` · `elyon config show`
Show (create if missing) the secret token for the local API; replace it (the running daemon picks up the new
one at once); show the configuration in use and where `config.json` lives.

---

## Spot

Spot markets are Elyon wrapped tokens traded against wUSDT in their Uniswap V2 pools, exactly like the
website's market pages. Orders wait (up to `--max-wait`, default 45 s) until the pool is within 0.10 % of
the global price, use 0.5 % maximum slippage by default (`--slippage`, up to 5), a 120 s deadline and an
exact approval of what is spent; trades with more than 15 % price impact are refused. ELN/WELN are not
tradable until ELN's exchange listing (use `gas buy`).

### `elyon spot markets [--search X] [--limit N]`
```text
$ elyon spot markets --search doge
MARKET     NAME                            PRICE (wUSDT)       24H       VOLUME 24H
wDOGE      Dogecoin                              0.06514    -1.18%        1,302,919
wAIDOGE    AIDOGE                              7.013e-12    -2.25%           32,678
wBABYDOGE  BabyDogeCoin                        2.781e-10    -2.49%           25,865
wELON      Dogelon Mars                        2.093e-08    -3.81%           20,436
wDOPE      Doge Pepe                             0.00079   -11.73%                0

5 of 5 markets shown. ELN is not traded on ElyonDex until its exchange listing.
```

### `elyon spot price <MARKET>`
```text
$ elyon spot price BTC
wBTC (Bitcoin) / wUSDT
  Pool price         68,780.63 wUSDT
  Global price       68,733.33 wUSDT
  Difference         +6.9 bps (in line, ready to trade)
  24h change         -4.46%
  24h volume         1,365,089 wUSDT
  Pool reserves      17.767125 wBTC / 1,222,034.16 wUSDT
  Pool fee           0.30 % per trade
```

### `elyon spot quote buy|sell|swap …`
Preview without trading: `spot quote buy BTC --spend 100`, `spot quote buy 0.01 BTC`,
`spot quote sell 0.01 BTC`, `spot quote swap 0.1 wBTC to wETH`.
```text
$ elyon spot quote buy BTC --spend 1
Quote: wUSDT → wBTC
  You pay            1 wUSDT
  You receive about  0.000014495347 wBTC
  Minimum received   0.00001442287 wBTC (slippage 0.50%)
  Price impact       0.00%
  Pool fee           0.30% of what you pay
  Pool price         68,780.63 wUSDT per wBTC (global 68,733.33)
```

### `elyon spot buy <MARKET> --spend <wUSDT>` · `elyon spot buy <amount> <MARKET>`
Spend an amount of wUSDT, or buy an exact amount of the token (the maximum paid is the quote plus
slippage).
```text
$ elyon spot buy BTC --spend 1
… Sending: approve wUSDT for the spot router…
… Confirmed: approve wUSDT for the spot router (0x9b76887b…3621)
… Sending: swap wUSDT → wBTC…
… Confirmed: swap wUSDT → wBTC (0x3f188467…7254)
Bought: paid 1 wUSDT, received 0.000014495347 wBTC
  Average price      68,987.65 wUSDT per wBTC
  Route              wUSDT → wBTC
  Price impact       0.00%
  Transaction        0x3f1884675b479a404f1dcd29dae92ac09b2feb7c5104dbbf24392d4533757254
  Network fee        0.000230004 ELN

$ elyon spot buy 0.00001 BTC
Bought: paid 0.688346 wUSDT, received 0.00001 wBTC
  Average price      68,834.60 wUSDT per wBTC
  …
```

### `elyon spot sell <amount|all> <MARKET>`
```text
$ elyon spot sell all BTC
… Waiting for the pool to match the global price (market makers keep it in line)…
… Confirmed: approve wBTC for the spot router (0x4c0a54a0…77ca)
… Confirmed: swap wBTC → wUSDT (0x36a45657…6a10)
Sold: paid 0.000014495347 wBTC, received 0.995169 wUSDT
  Average price      68,654.37 wUSDT per wBTC
  Route              wBTC → wUSDT
```

### `elyon spot swap <amount|all> <TOKEN> to <TOKEN>`
Any two tokens; when neither is wUSDT the route goes through the wUSDT hub (two pools, 0.6 % pool fees).
```text
$ elyon spot swap all wBTC to wETH
Swapped: paid 0.00001 wBTC, received 0.00035301849 wETH
  Route              wBTC → wUSDT → wETH
  Price impact       0.00%
  Transaction        0x10311f6b117291c8a625b6c4fc9b66177326c9b19810c1d18c9d7c2f17768a46
```
```text
$ elyon spot buy ELN --spend 1
Error: ELN is not traded on ElyonDex until its exchange listing. To pay network fees, buy ELN for gas at a fixed price with wUSDT: `elyon gas buy <ELN amount>`.
```

---

## Futures

USDT-margined perpetuals, **isolated margin** (a position can never lose more than its margin), exactly the
website's contracts: positions open through the TP/SL router, limit orders through the limit router. The fee
is 0.10 % of the position size on open and again on close. Every open/close uses a fresh price signed by the
exchange (checked by elyon and by the contract; valid 20 s — elyon fetches a new one automatically if it
aged before sending).

### `elyon futures markets [--search X] [--category C] [--limit N]`
```text
$ elyon futures markets --search gold
MARKET         TYPE          LAST (wUSDT)       24H    FUNDING  MAX LEV  STATUS
GOLDCIRSTOCK   stocks             31.1400    -0.06%   -0.0126%      20x  open
XAU            metals            3,887.80    +0.22%    0.0085%    1000x  open
XAUT           metals            3,873.42    +0.21%    0.0099%    1000x  open
PAXG           metals            3,873.45    +0.23%    0.0050%     100x  open
GLD            metals            355.6900    +0.18%   -0.0116%      20x  open

5 of 5 markets shown. Fee: 0.10% of the position size on open and on close. Isolated margin only.
```

### `elyon futures price <MARKET>`
```text
$ elyon futures price BTC
BTC/wUSDT perpetual (BTC_USDT)
  Last price         68,845.20 wUSDT  (positions open and close at this price)
  Mark price         68,857.80 wUSDT
  Index price        68,868.80 wUSDT
  24h change         -0.04%  (high 72,194.00, low 67,490.00)
  Funding / 8h       0.0040% (longs pay shorts)
  Max leverage       500x (safe max 499x with fees)
  Fee                0.100% of the position size, on open and on close
  Maintenance        0.10%
  Status             open for trading
```

### `elyon futures funding <MARKET>`
```text
$ elyon futures funding ETH
Funding of ETH_USDT
  Rate / 8h          0.0042% (longs pay shorts)
  Next funding       2026-11-14 00:00 UTC (in 7h33m0s)
  Schedule           every 8 hours at 00:00, 08:00 and 16:00 UTC; settled when the position closes
```
If you hold positions in the market, it also estimates what each pays or receives at the next funding.

### `elyon futures open long|short <MARKET> … --leverage <x> [--take-profit P] [--stop-loss P]`
Size the order with exactly one of:

| Option | Meaning |
|---|---|
| `--margin 10` | 10 wUSDT of margin (minimum 1) |
| `--size 100` | position size 100 wUSDT (margin = size / leverage) |
| `--quantity 0.01` | position size in the asset (0.01 BTC at the current price) |
| `--risk 5` | lose at most 5 wUSDT at the stop loss (requires `--stop-loss`; includes the closing fee) |

`--leverage` is required (1 to the market's safe maximum). Take profit must be beyond the price and the stop
loss before it and before the liquidation price (with the website's 0.05 % band); they are checked again at
the signed fill price. `--approve-unlimited` sends one unlimited wUSDT approval instead of exact approvals.
```text
$ elyon futures open long BTC --margin 1 --leverage 2
… Sending: approve wUSDT for the futures contract…
… Fetching a signed market price…
… Sending: open long BTC 2x…
Opened LONG BTC 2x at 68,816.10 wUSDT
  Position           #6255260
  Margin             1 wUSDT (isolated)
  Size               2 wUSDT ≈ 2.9063e-05 BTC
  Fee paid           0.002 wUSDT
  Liquidation        34,476.97 wUSDT (-49.90%) — at this price the whole margin is lost
  Take profit        none
  Stop loss          none
  Transaction        0x2757e64b7ab658318955cb3afb5228bb84faa6a96e43b931f8aecd25f4124200
```

### `elyon futures positions [--market M]`
Open positions read from the chain, with the exact settlement if closed now (contract `previewClose`).
```text
$ elyon futures positions
#6255260  LONG BTC_USDT 2x  (isolated)
  Margin / size      1 wUSDT / 2 wUSDT ≈ 0.00002906 BTC
  Entry / last       68,816.10 / 68,809.90
  Liquidation        34,476.97
  PnL                -0.00018 wUSDT (-0.02% on margin)
  If closed now      receive ≈ 0.997821 wUSDT (after 0.001999 fee and 0 funding)
  TP / SL            79000 / 60000
```

### `elyon futures set-tp-sl <id> [--take-profit P|none] [--stop-loss P|none]`
Set, change or remove; an option you leave out keeps its current value.
```text
$ elyon futures set-tp-sl 6255260 --take-profit 80000 --stop-loss 60000
Position #6255260 (LONG BTC_USDT): take profit 80,000.00 · stop loss 60,000.00
  Transaction        0x15f1c58a476d421c29d6ad75333757eedc3ce83695cf435066c67ff589fbf3b9
  The keeper closes the whole position at the market price within seconds when the last price reaches one of them.
$ elyon futures set-tp-sl 6255260 --take-profit 79000
Position #6255260 (LONG BTC_USDT): take profit 79,000.00 · stop loss 60,000.00
$ elyon futures set-tp-sl 6255260 --take-profit none --stop-loss none
Position #6255260 (LONG BTC_USDT): take profit none · stop loss none
```

### `elyon futures close <id> [--percent P]`
Close at the market price, completely or a part (1–100 %). The rest keeps its entry, leverage, liquidation
price and TP/SL.
```text
$ elyon futures close 6255260 --percent 50
Closed 50% of position #6255260 (LONG BTC_USDT)
  Exit price         68,800.30 wUSDT
  PnL of the part    -0.000229 wUSDT
  Closing fee        0.000999 wUSDT
  Paid to wallet     0.498772 wUSDT
  Rest               stays open with the same entry price, leverage, liquidation price and TP/SL
$ elyon futures close 6255260
Closed position #6255260 (LONG BTC_USDT)
  Exit price         68,793.20 wUSDT (entry 68,816.10)
  PnL                -0.000332 wUSDT
  Funding            0 wUSDT
  Closing fee        0.000999 wUSDT
  Paid to wallet     0.498669 wUSDT
```

### `elyon futures close-all [--market M]`
Closes every open position (one transaction each), continues past failures and reports each one.
```text
$ elyon futures close-all
Closed position #6255262 (SHORT ETH_USDT)
  …  Paid to wallet     0.99916 wUSDT
Closed position #6255261 (LONG BTC_USDT)
  …  Paid to wallet     0.498018 wUSDT

Closed 2 position(s).
```

### `elyon futures limit long|short <MARKET> --price P … --leverage x [--expires 7d] [--take-profit P] [--stop-loss P]`
Rests on ElyonChain; nothing is taken until it fills at the limit price or better. A long limit must be
below the current price, a short limit above it. Expiry 1 minute to 90 days (`30m`, `12h`, `7d`, `4w`;
default 30 days). The wallet must keep the order's cost (margin + fee) until it fills; at most 25 open
orders per wallet.
```text
$ elyon futures limit long BTC --price 50000 --margin 1 --leverage 2 --expires 1d
Limit order #4 placed: LONG BTC 2x at 50,000.00 wUSDT or better
  Margin / size      1 wUSDT / 2 wUSDT
  Taken when filled  1.002 wUSDT (margin + fee); nothing was taken now
  Expires            2026-11-14 16:10 UTC
  Take profit        none
  Stop loss          none
  Transaction        0xc6dba596fc4efd4b2645f869f9b67b5ed09c9264c6c6a632dc5468a30670c403
```

### `elyon futures orders [--all]` · `elyon futures cancel <id>` · `elyon futures cancel-all [--market M]`
```text
$ elyon futures orders
Order #4  LONG BTC_USDT 2x at 50,000.00  [open]
  Margin / cost      1 wUSDT / 1.002 wUSDT when filled
  Expires            2026-11-14 16:10 UTC
  TP / SL            none / none
$ elyon futures cancel 4
Cancelled limit order #4. Nothing was taken from the wallet.
  Transaction        0xd563a8703e72c718b58c6aee9416b8466bbba1d3e73641e4119918806ab3b02e
```

### `elyon futures history [--limit N]`
Closed positions and past limit orders as indexed by the DEX (may lag a few seconds).
```text
$ elyon futures history
#6255263 LONG BTC_USDT 2x · margin 1.0 · entry 68,584.00 → exit 68,572.20 · PnL -0.000344 · paid 0.997657 wUSDT · closed
#6255262 SHORT ETH_USDT 2x · margin 1.0 · entry 1,934.21 → exit 1,933.09 · PnL 0.001158 · paid 0.99916 wUSDT · closed

Past limit orders:
  #5 SHORT BTC_USDT 2x at 90,000.00 — cancelled
```

---

## Gas and wrapping

### `elyon gas price` · `elyon gas buy <ELN amount>`
Buy ELN for network fees at the fixed price, paid in wUSDT (the website's "Buy ELN for gas"; 0.1–50 ELN per
purchase, 100 ELN per wallet per day).
```text
$ elyon gas price
Buy ELN for gas (fixed price, paid in wUSDT)
  Price              0.8 wUSDT per ELN
  Per purchase       0.1 to 50 ELN
  Per wallet per day 100 ELN (resets 00:00 UTC)
  Left today         100 ELN
  Available          9999 ELN
  Status             open
$ elyon gas buy 0.1
You received 0.1 ELN for 0.08 wUSDT.
  Transaction        0xacdc41b2856a66a42d8afb5fe5726d80c9df9fd7eca67c99ab1bc1863e814edc
```

### `elyon wrap <amount|all>` · `elyon unwrap <amount|all>`
ELN ↔ WELN, 1:1. `wrap all` keeps some ELN for network fees.

---

## Daemon and automation

### `elyon serve [--listen addr] [--allow-ip list] [--auto-lock 30m] [--rate 20] [--tls-cert f --tls-key f]`
Unlocks the key once and serves the HTTP API (see [http-api.md](http-api.md)). While it runs, one-shot
commands that sign are executed by it (no password prompt):
```text
$ elyon futures open short ETH --margin 1 --leverage 2
… sent to the running elyon daemon (http://127.0.0.1:7457)
Opened SHORT ETH 2x at 1,934.21 wUSDT
  Position           #6255262
```

### `elyon unlock` · `elyon lock`
Unlock the running daemon with the password (after an auto-lock or a password change); wipe the key from its
memory immediately.

### `elyon run <batch.json|-> [--continue-on-error]`
Run several commands in order; see [http-api.md](http-api.md#batch) for the format. By default the batch
stops at the first failure and marks the rest as skipped.
```text
$ elyon run batch-demo.json
── step 1: spot.price — OK
…
── step 3: spot.buy — FAILED
  ELN is not traded on ElyonDex until its exchange listing. …
── step 4: futures.positions — SKIPPED
```

### `elyon tx <hash>`
```text
$ elyon tx 0x2757e64b7ab658318955cb3afb5228bb84faa6a96e43b931f8aecd25f4124200
Transaction 0x2757e64b…4200: CONFIRMED in block 5904255 (gas 432223, fee 0.000864446 ELN)
https://explorer.elyon.network/tx/0x2757e64b7ab658318955cb3afb5228bb84faa6a96e43b931f8aecd25f4124200
```

### `elyon commands`
The full catalogue (name, HTTP path, parameters) — `--json` for programs.

---

## Errors

Every error has a stable **code** for programs and a plain English **message** (+ often a **hint**):

```text
$ elyon futures open long BTC --margin 1
Error: Choose the leverage with --leverage, for example --leverage 5.
```
```json
{"ok": false, "command": "futures.open", "error": {"code": "INVALID_INPUT", "message": "Choose the leverage with --leverage, for example --leverage 5."}}
```

Common codes (full list in [http-api.md](http-api.md#error-codes)): `INSUFFICIENT_BALANCE` (not enough wUSDT
or token), `NOT_ENOUGH_ELN_FOR_GAS` (send ELN or `gas buy`), `MARKET_CLOSED` (outside trading hours),
`MARKET_CLOSE_ONLY`, `QUOTE_EXPIRED` (retry), `PRICE_MOVED` (slippage exceeded; retry or raise
`--slippage`), `POOL_NOT_READY` (retry), `ELN_NOT_TRADABLE`, `WALLET_LOCKED`, `PASSWORD_EXPIRED`,
`TRANSFER_NOT_ALLOWED`, `DAILY_LIMIT_REACHED`, `CONTRACT_MISMATCH` (update elyon), `TRANSACTION_PENDING`
(check with `elyon tx`).
