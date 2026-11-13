# Back up and restore

Your bot's wallet lives in one place: the computer where elyon runs. The **24-word recovery phrase** is the only way to
get it back if that computer breaks, is stolen, or you move to a new one. Elyon cannot recover it for you — that is
exactly why nobody but you can ever use it.

## You get the phrase once

When you create the wallet (`elyon setup` or `elyon wallet create`), elyon shows the 24 words **once**:

1. Write them on paper, numbered, in the same order. Do not photograph them and do not type them into chats,
   e-mails, cloud notes or websites.
2. Press Enter. The screen is cleared.
3. elyon asks for three of the words at random ("Word #3", "Word #10", "Word #15"). If a word is wrong you get two
   more tries. This proves the paper copy is correct **before** you put money in the wallet.
4. When the answers are right you see `✓ Backup confirmed.` From now on the phrase is not shown again.

If you skipped the quiz, `elyon status` shows that the backup is not confirmed, and `elyon wallet backup` shows the
phrase one last time and asks the quiz again.

### If you lost the paper but the computer still works

Do not wait. Either move the funds to a new wallet you back up properly, or show the phrase one more time:

```bash
elyon wallet backup --show-again-i-understand-the-risk
```

It asks you to type `SHOW` and your password, and it counts how many times the phrase was shown.

## Move to a new computer (or rebuild a broken one)

1. Install elyon on the new computer ([Windows](install-windows.md), [macOS](install-macos.md),
   [Linux](install-linux.md), [Docker](install-docker.md)).
2. Run `elyon setup` and choose **2 — Restore**, or run `elyon wallet restore`.
3. Type the 24 words when asked (the input is hidden), then choose a new password.
4. elyon prints the wallet address. **Check that it is the address you expect** before you trade:

```text
Wallet restored. Address on ElyonChain:

  0xe60Cb95FbB1647AfB982C4f2c5D19F475fd7ebD7

Check that this is the address you expect before sending funds.
```

Your balances, open futures positions and limit orders are on ElyonChain, not on the computer, so they are all there
again as soon as the wallet is restored. Start `elyon serve`, give your bot the new API token
(`elyon api-token show`), and it continues where it stopped.

The phrase also works in MetaMask and other standard wallets: the first account it shows is the same address.

### Restoring from a private key

If you created the wallet from a private key instead of a phrase, restore it with:

```bash
elyon wallet restore --private-key
```

## Retire the old computer

Once the new computer works, remove the wallet from the old one: delete elyon's data folder there
(`%APPDATA%\Elyon` on Windows, `~/Library/Application Support/Elyon` on macOS, `~/.config/elyon` on Linux, the
`elyon-data` volume with Docker). Without the password the old file is useless, but there is no reason to leave it
behind.

## Your password

The password protects the key **on this computer**. It is not part of the backup: on a new computer you choose a new
one. Change it whenever you like with `elyon password change`; by default elyon requires a change every 90 days, warns
14 days before, and after that refuses to unlock until you change it.
