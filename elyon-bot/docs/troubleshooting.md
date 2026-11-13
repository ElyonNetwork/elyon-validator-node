# Troubleshooting and FAQ

Every error elyon reports has a stable **code** (for your bot) and a plain English **message** (for you), often with a
**hint** saying what to do. With `--json` or the HTTP API the code is in `error.code`.

## The most common messages

| What you see | What it means | What to do |
|---|---|---|
| `NOT_ENOUGH_ELN_FOR_GAS` | The wallet has too little ELN to pay the network fee. | Send 0.1–0.5 ELN from your ElyonDex wallet, or run `elyon gas buy 0.5` (paid in wUSDT). |
| `INSUFFICIENT_BALANCE` | Not enough wUSDT (or of the token you sell). | Send more wUSDT to the bot's address, or lower the amount. |
| `WALLET_LOCKED` | The daemon is running but locked (auto-lock, or `elyon lock`). | Run `elyon unlock` and type the password. |
| `PASSWORD_EXPIRED` | The password is older than the allowed age (90 days by default). | Run `elyon password change` in a terminal. |
| `TOO_MANY_PASSWORD_ATTEMPTS` | Five wrong passwords in a row. | Wait 15 minutes, then try again carefully. |
| `QUOTE_EXPIRED`, `PRICE_FEED_UNAVAILABLE` | The signed futures price was too old by the time it was used. | Retry. Your bot should simply try again after a second. |
| `PRICE_MOVED` | The price moved more than the allowed slippage. Nothing was traded. | Retry, or allow more slippage (`--slippage`). |
| `POOL_NOT_READY` | The spot pool had not caught up with the global price in time. | Retry in a few seconds. |
| `MARKET_CLOSED` | A stock, index or commodity market outside its trading hours. | Wait until the market opens again. |
| `ELN_NOT_TRADABLE` | ELN is not traded in the spot markets until its exchange listing. | Use `elyon gas buy` to get ELN for fees. |
| `TRANSFER_NOT_ALLOWED` | A transfer to an address you have not approved, without the password. | Approve it once with `elyon wallet allow <address>`, or pass the password. |
| `DAILY_LIMIT_REACHED` | Your own daily transfer limit is used up. | Wait, or change it with `elyon wallet limit`. |
| `TRANSACTION_PENDING` | A transaction was sent but not confirmed in time. | Check it with `elyon tx <hash>` before sending again. |
| `NONCE_CONFLICT` | Another program is using the same wallet at the same time. | Use each wallet in one elyon only. |
| `CONTRACT_MISMATCH` | The exchange reports a contract this version does not trust. | Download the latest elyon. |

The complete list is in the [HTTP API reference](http-api.md#error-codes).

## Questions

**Does Elyon ever see my key or my password?**
No. Both stay on your computer. elyon only talks to the ElyonChain RPC (`https://mainnet.elyon.network/rpc`) and the
ElyonDex public API (`https://dex.elyon.network`), and the [source code is public](https://github.com/ElyonNetwork/elyon-validator-node/tree/master/elyon-bot) so anyone can check.

**My computer was stolen. What can the thief do?**
Without your password: nothing — the wallet file is encrypted and the daemon is not running. Restore the wallet on
another computer with your 24 words and move the funds to a new wallet straight away. See
[Back up and restore](backup-and-restore.md).

**Do I have to type the password every time?**
No. Start `elyon serve` once; while it runs, both your bot and one-shot `elyon …` commands use it without asking. If
the computer must restart unattended, read the "Unattended mode" part of [Security and your key](security.md) first.

**Can my bot withdraw money to anywhere?**
Only if you allow it. Trading commands can only pay into the wallet itself. `wallet send` needs the password in the
request or a destination you approved beforehand, and respects your daily limits.

**Which markets can my bot trade?**
Every spot market and every futures market of ElyonDex: `elyon spot markets` and `elyon futures markets` list them,
with `--search` to find one.

**Can my bot place limit orders?**
For futures, yes: `elyon futures limit long|short …`, `elyon futures orders`, `elyon futures cancel`. Spot trades are
market swaps, exactly as on the website.

**What do trades cost?**
The same as on the website: the pool fee for spot, the futures fee on each fill, and a tiny ELN network fee per
transaction.

**Can I run several bots?**
Yes. Several bots can share one elyon (they all use the same wallet), or you can run separate elyon instances with
separate wallets, each with `--home` pointing to its own folder.

**How do I update?**
Download the new version, check its checksum, and replace the program file. Your wallet folder stays as it is.

**Where do I get help?**
Use **Live support** on [dex.elyon.network](https://dex.elyon.network). Never send anyone your password, your 24 words
or your API token — support will never ask for them.
