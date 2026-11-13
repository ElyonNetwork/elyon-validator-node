# Security of elyon-bot

elyon-bot holds a key that controls real money on ElyonChain. This document explains what protects it,
what an attacker can and cannot do, and how to operate it safely. Report vulnerabilities privately to the
Elyon team (security contact on https://dex.elyon.network) before publishing them.

## Principles

1. **The key never leaves your computer.** It is generated locally from the operating system's
   cryptographic random generator (256 bits → 24-word BIP-39 phrase → key at `m/44'/60'/0'/0/0`), stored
   encrypted, and used only inside the elyon process to sign transactions. Only *signed transactions* are
   sent to the network.
2. **No telemetry, no phoning home.** The only network connections are to the configured ElyonChain RPC
   (`https://mainnet.elyon.network/rpc`) and the DEX public API (`https://dex.elyon.network`). The only thing
   about you the DEX API ever receives is your public wallet address, in the two history queries the website
   also makes (`/api/futures/positions?wallet=`, `/api/futures/orders?wallet=`). You can verify this in
   `internal/dex/client.go` and `internal/chain/client.go` — there is no other networking code.
3. **Everything is open source and reproducible.** Build it yourself (`scripts/build.sh`) and compare the
   checksums with the published `SHA256SUMS`.

## How the key is stored (`wallet.json`, mode 0600)

| Part | Protection |
|---|---|
| Recovery phrase (or imported private key) | AES-256-GCM. The 32-byte key comes from your password through **scrypt N=2^18, r=8, p=1** with a random 32-byte salt (about 1 s and 256 MB per guess). The GCM additional data binds the ciphertext to the wallet address and kind. |
| Address | Stored in clear so read-only commands (balance, positions) work without the password; the daemon verifies it against the decrypted key at unlock. |
| Security settings: password changed-at and max age, backup confirmed, approved transfer addresses, daily transfer limits | Stored in clear but **signed** (HMAC-SHA256 with a key derived by HKDF from the private key). A modified file is detected at unlock and refused: an attacker cannot add their address to your approved list or extend your password's life without the key. |
| Password | Never stored. A wrong password simply fails to decrypt. |

Weak scrypt parameters in a tampered file are refused before any work is done. Files are written
atomically (temporary file + rename) so a crash never leaves half a wallet.

On Windows, files live under your user profile (`%APPDATA%\Elyon`), whose default permissions allow only
you, SYSTEM and administrators. Do not move the elyon home to a shared folder.

## Password policy

- At least **12 characters**, at least 5 different characters, not a well-known pattern.
- **Maximum age** (default **90 days**, configurable 7–365 with `elyon password policy --max-age-days N`).
  From 14 days before expiry every command shows a warning. After expiry the wallet **refuses to unlock**
  and a running daemon locks itself within a minute; run `elyon password change` (it requires the old
  password; works even when expired), then `elyon unlock`.
- The daemon blocks password checks for 15 minutes after **5 wrong passwords** (unlock, transfers,
  allowlist changes), so a stolen API token cannot be used to guess the password over HTTP.
- The password is never accepted as a command-line argument (it would land in your shell history).

## The recovery phrase ("you get your key once")

- `elyon setup` / `elyon wallet create` show the 24 words **once**, in a terminal only, then clear the
  screen and ask for 3 random words to prove you wrote them down. The wallet records that the backup was
  confirmed.
- Afterwards `elyon wallet backup` **refuses** to show the phrase again, unless you pass
  `--show-again-i-understand-the-risk`, type `SHOW`, and enter the password in the terminal. Each display is
  counted in the signed settings.
- The phrase is never available over the HTTP API, never written to logs, and never accepted from the
  command line (restore reads it from a hidden prompt or from standard input).
- With the phrase you can restore the wallet anywhere: `elyon wallet restore` on a new computer, or MetaMask
  (it shows the same address as its first account).

## The local API (`elyon serve`)

Requests pass these checks in order:

1. **Size limit** (256 KB per request).
2. **Client address**: with the default bind `127.0.0.1` only local programs can connect. When you bind to
   another interface (Docker), use `--allow-ip` (single IPs or CIDR ranges); without it the daemon prints a
   warning at start.
3. **Host and Origin checks** (loopback bind): a malicious web page cannot reach the API through DNS
   rebinding (its `Host` would be its own domain) and cross-site browser requests are refused.
4. **Rate limit** per client address (default 20 requests/s, burst 40; `--rate`).
5. **Bearer token**: 256 random bits in its own file `api-token` (0600), compared in constant time (SHA-256 of
   both sides); 5 wrong tokens, then one guess per 12 s per address. `elyon api-token rotate` replaces it;
   the daemon picks up the new file without a restart.
6. The command's own checks: locked wallet, expired password, password for transfers, etc.

Other protections: optional **idle auto-lock** (`--auto-lock 30m`: the key is wiped from memory after
30 minutes without a command; unlock again with `elyon unlock`); `POST /v1/lock` wipes the key at once;
Ctrl+C / SIGTERM wipe it before exiting; interactive commands (setup, backup, password change) are not
available over HTTP; optional TLS (`--tls-cert/--tls-key`) when the API must cross a network.

## Transfers out of the wallet

Trading commands can only send value **to the wallet itself**: swap outputs go to your address, futures
payouts go to the trader (enforced by the Elyon contracts), approvals only go to the pinned Elyon contracts.
The single way out is `wallet send`, which requires **one of**:

- the **wallet password in that same request** (the CLI asks for it; over HTTP the `password` field), or
- a destination on your **approved list** — and adding to the list requires the password
  (`elyon wallet allow <address>`).

In addition, optional **daily limits** per coin/token (`elyon wallet limit 500 wUSDT`, password required)
cap what can leave in any rolling 24 hours, even with the password. `wallet send` also refuses the zero
address, your own address, Elyon contract addresses, token contracts, and any smart contract unless you add
`--allow-contract`.

## Threat model

### An attacker who gets your computer or a copy of your files, but not the password

| They can | They cannot |
|---|---|
| See your wallet address, and therefore your balances and positions (public on-chain anyway). | Decrypt the key: they must guess the password offline at ~1 s and 256 MB of memory per guess (scrypt). A 12+ character password from a sentence is far beyond reach. |
| Read `audit.log` (commands, amounts, transaction hashes — never secrets). | Sign any transaction, trade, or move funds. |
| Read `api-token` — useful **only** while your daemon is running *and unlocked* on that machine. With auto-lock or after a reboot (daemon locked/not running) the token alone does nothing. | Add their address to your approved list, raise your limits, extend the password's age or re-enable the phrase display: those settings are signed with the key, so tampering is detected and the wallet refuses to unlock. |
| Delete or corrupt your files (keep the recovery phrase on paper!). | Learn the recovery phrase: it is inside the encrypted part. |

**Important:** if you use the unattended mode (`ELYON_PASSWORD_FILE`), the password sits on the same
machine; then whoever can read that file can use the wallet. See below.

### An attacker who controls a program on the same computer, as your user, while the daemon is unlocked

This is the strongest local position short of the password: they can read the API token and send trading
commands. Limits that still hold: they **cannot withdraw** to their own address without the password
(unless it is on your approved list, and then only within your daily limit); trades can only pay back to
your own wallet. Keep the daemon locked when you are not trading (`--auto-lock`, `elyon lock`), keep few
funds in the bot wallet, and approve only addresses you control. Malware running as your user can of course
also log your keystrokes; protect the computer itself.

### A compromised or impersonated DEX API

elyon treats the API as untrusted for anything that moves money: contract addresses are compiled in and
must match; token tickers must match the built-in list (new listings are marked); pool addresses must equal
their CREATE2 address on the canonical factory; futures prices must be signed by a feeder registered
on-chain on the market contract (the contracts check this too); slippage and price-impact limits come from
the client. A lying API can at worst show wrong market data or make trades fail.

### A malicious RPC node

It cannot steal anything: transactions are signed locally for chain id 55452773 only (elyon refuses any
other chain). It could lie about balances or prices; use the official RPC or your own node.

### What elyon cannot protect against

A keylogger or root-level malware on your machine; someone who has both your files and your password; a
recovery phrase stored in a photo, a cloud note or an e-mail; bugs in the Elyon contracts themselves.
Memory wiping in Go is best effort (the garbage collector may keep copies), so a memory dump of a running,
unlocked daemon could reveal the key.

## Unattended mode

For servers and Docker containers that must restart without a human, elyon can read the password from:

- `ELYON_PASSWORD_FILE=/path/to/file` — a file containing only the password (`chmod 600`; elyon warns if
  other users can read it), e.g. a Docker secret mounted at `/run/secrets/elyon_password`; or
- `ELYON_PASSWORD` — the password itself in an environment variable (discouraged: other processes of the
  same user, `docker inspect` and crash dumps can reveal it).

Both print a warning every time they are used. This is an **explicit opt-in**: anyone who can read the file
or the environment can unlock your wallet, which removes the "stolen files without the password" protection
above. If you use it, keep only the funds the bot needs in this wallet, use daily limits and the approved
list, and protect the host.

`password change`, `wallet backup` and the reveal of the phrase never use these variables: they always need
a person at a terminal.

## Operational checklist

- Write the 24 words on paper during setup; store it offline. Never type it into a website.
- Use a unique password of 12+ characters; change it before it expires (`elyon status` shows the date).
- Keep only trading capital in the bot wallet; withdraw profits to an approved address of yours.
- `elyon wallet allow <your DEX wallet>` once, and set `elyon wallet limit` for wUSDT and ELN.
- Run `elyon serve` on `127.0.0.1` (default). In Docker publish the port only on the host's loopback
  (`-p 127.0.0.1:7457:7457`) and use `--allow-ip` for the Docker network.
- Use `--auto-lock` if the bot does not trade continuously.
- Review `audit.log` from time to time; rotate the API token if you think it leaked
  (`elyon api-token rotate`).

## Implementation map (for reviewers)

| Topic | File |
|---|---|
| Key generation, derivation, encryption, signed settings, password policy, quiz | `internal/keystore/` |
| Password prompts, unattended mode, terminal-only flows | `internal/cli/prompt.go`, `internal/cli/interactive.go` |
| HTTP API protections | `internal/server/server.go`, `internal/apitoken/` |
| Transfer rules and daily limits | `internal/guard/`, `internal/app/wallet.go` (`walletSend`) |
| Pinned contracts and endpoints | `internal/config/config.go` |
| Built-in token list | `internal/registry/` |
| Futures quote verification | `internal/futures/logic.go`, `internal/app/futures_data.go` (`signedQuote`) |
| Pool verification (CREATE2) | `internal/spot/pair.go`, `internal/app/spot.go` (`readPool`) |
| Audit log redaction | `internal/audit/` |
| All network I/O | `internal/chain/client.go`, `internal/dex/client.go` |
