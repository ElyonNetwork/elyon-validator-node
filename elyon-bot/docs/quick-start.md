# Quick start

From zero to your bot's first order in about ten minutes. Every step has a detailed guide with screenshots for
[Windows](install-windows.md), [macOS](install-macos.md), [Linux](install-linux.md) and [Docker](install-docker.md).

## What you are installing

`elyon` is a small, open-source program with **no graphical interface**. Your bot sends it commands in plain
English — `spot buy`, `futures open long`, `futures close-all` — and elyon carries them out on ElyonDex, signing each
transaction with your bot's own key.

- The key is **created on your computer** and stored there, **encrypted with your password**. It is never sent
  anywhere. ElyonDex never sees it and cannot use it.
- It does exactly what the website does — the same contracts, prices, fees and rules — without a wallet pop-up for
  every order.
- It works on **ElyonChain only**. Deposits and withdrawals to other networks still go through the website.

## 1. Download and check the file

Download the file for your system from the [download table](https://dex.elyon.network/bots#download) together with
`SHA256SUMS`, and check that the file's SHA-256 checksum matches the one in `SHA256SUMS`. The install guides show the
exact command for each system.

## 2. Create your bot wallet

```bash
elyon setup
```

1. Choose **1** to create a new wallet.
2. Choose a password of at least 12 characters (a short sentence works well). You need it whenever the client starts,
   and you will be asked to change it every 90 days.
3. Write the **24 words** of your recovery phrase **on paper**, in order. They are shown only this once.
4. The screen is cleared and you are asked for three of the words. This proves you really have them.

> **Important:** the 24 words are the only way to get your wallet back if this computer breaks. Keep the paper
> offline and private. Nobody from Elyon will ever ask for them. See [Back up and restore](backup-and-restore.md).

## 3. Fund it

```bash
elyon wallet address
```

Send **wUSDT** (the money your bot trades with) and **0.1–0.5 ELN** (for network fees) from your ElyonDex wallet to
this address. If you have no wUSDT yet, deposit USDT on ElyonDex first — [Fund your bot wallet](funding.md) explains
every step. Then check:

```bash
elyon wallet balance
```

## 4. Your first commands

```bash
elyon futures price BTC
elyon spot buy BTC --spend 10
elyon futures open long BTC --margin 5 --leverage 3 --stop-loss 60000
elyon futures positions
elyon portfolio
```

Add `--json` to any command to get machine-readable output. `elyon help` lists everything; the
[command reference](commands.md) explains each command with examples.

## 5. Connect your bot

Start the local API once (it asks for your password and keeps the key unlocked only in memory):

```bash
elyon serve
```

In another window, get the secret token your bot sends with every request:

```bash
elyon api-token show
```

Your bot now calls `http://127.0.0.1:7457` — for example `POST /v1/futures/open` with a JSON body — from any
programming language. [Code examples](examples.md) has complete, tested bots in Python, JavaScript (Node.js), Go, C#,
Java, PHP, Rust, Ruby, PowerShell, Bash and the Windows Command Prompt, with the exact install and run steps for
Windows, macOS, Linux and Docker. Every endpoint is in the [Local HTTP API](http-api.md) reference.

## Keep it safe

- Never share the password, the 24 words or the API token.
- Run the client only on a computer you control. Keep the API on `127.0.0.1` unless you know why you change it.
- Approve your own withdrawal addresses with `elyon wallet allow`, and set daily limits with `elyon wallet limit`.
- Read [Security and your key](security.md) once — it explains exactly what an attacker can and cannot do.

Trading involves risk and leverage can lose your whole margin. A bot does exactly what it is told: test with small
amounts first.
