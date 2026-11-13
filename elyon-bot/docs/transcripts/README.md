# Live terminal transcripts (ElyonChain mainnet, 2026-11-13)

Real, unedited output of elyon 0.1.0 (commit 9f2dddfadcf8) from the end-to-end test on mainnet, captured
for documentation and screenshots. Only these changes were made:

- the 24 recovery words in `01-setup.txt` are replaced by `••••••` (they were never printed anywhere else);
- the temporary test folder is shown as `~/.config/elyon`;
- the API token is shown as `$ELYON_TOKEN` and passwords as `<redacted>` in the curl commands.

The test wallet (`0xe60C…ebD7`) was funded with 6 wUSDT and 0.3 ELN from the operator test wallet
(`0x0E0b…e27`, transcript `02-funding.txt`) and everything left was returned at the end
(`22-return-funds.txt`). Futures positions used 1 wUSDT of margin at 2× (2 wUSDT notional, below the hedge
venue minimum). The CLI runs used the documented unattended mode (`ELYON_PASSWORD_FILE`), which is why they
print its warning.

| File | What it shows |
|---|---|
| `01-setup.txt` | guided setup: new wallet, password, one-time phrase display, quiz |
| `02-funding.txt` | the operator wallet sending 6 wUSDT + 0.3 ELN with `wallet send` |
| `03-status-balance.txt` | `status`, `wallet balance` |
| `04-backup-locked.txt` | the phrase is not shown a second time |
| `05-spot-cli.txt` | spot price, quote, buy 1 wUSDT of wBTC, sell all |
| `06-futures-cli.txt` | open long BTC 1 wUSDT ×2, set / change / remove TP/SL, close 50 %, close |
| `07-limit-cli.txt` | limit order far from the price, list, cancel |
| `10-api-basics.txt` | `GET /v1/status` from the daemon |
| `11-api-security.txt` | missing / wrong token, DNS-rebinding Host, foreign Origin |
| `12-api-spot.txt` | spot buy and sell over HTTP |
| `13-api-futures.txt` | open with TP/SL, change TP/SL, partial close over HTTP |
| `14-cli-via-daemon.txt` | a CLI command executed by the running daemon (no password prompt) |
| `15-api-aggregates.txt` | limit order, `portfolio`, `close-all`, `cancel-all` |
| `16-batch.txt` | batch over HTTP and `elyon run` with stop-on-error |
| `17-gas-wrap.txt` | buy ELN for gas, wrap, unwrap |
| `18-transfer-guard.txt` | transfer refused without password, daily limit, approved address, permitted transfer |
| `19-lock-unlock.txt` | lock, refused trade while locked, unlock |
| `20-spot-exact-and-swap.txt` | buy an exact amount, two-hop swap wBTC → wUSDT → wETH, sell |
| `21-history.txt` | futures history |
| `22-return-funds.txt` | send all wUSDT and all ELN back |
| `23-all-transactions.tsv` | every transaction hash of the run (46) |
