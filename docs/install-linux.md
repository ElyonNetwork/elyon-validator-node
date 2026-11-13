# Install elyon on Linux

Any 64-bit distribution (x86-64 or ARM64: servers, desktops, Raspberry Pi 4/5). The binary is static: no
dependencies.

## 1. Download and verify

```sh
ARCH=$(uname -m | sed 's/x86_64/amd64/; s/aarch64/arm64/')
VERSION=0.1.0
# download elyon-$VERSION-linux-$ARCH and SHA256SUMS from the release page, then:
sha256sum --check --ignore-missing SHA256SUMS      # must print: elyon-…: OK
install -m 0755 elyon-$VERSION-linux-$ARCH ~/.local/bin/elyon   # or: sudo install … /usr/local/bin/elyon
elyon version
```
(Make sure `~/.local/bin` is in your `PATH`.)

Build from source instead: install Go 1.26+, then `git clone … && cd elyon-bot && scripts/build.sh`.

## 2. Create your wallet

```sh
elyon setup
```
Choose **1**, a password of 12+ characters, and **write the 24 words on paper** (shown once, then a 3-word
check). Data: `~/.config/elyon` (`$XDG_CONFIG_HOME/elyon`), directory 0700, files 0600.

## 3. Fund it and trade

```sh
elyon wallet address          # send wUSDT + 0.1–0.3 ELN here from your DEX wallet
elyon wallet balance
elyon futures open long BTC --margin 10 --leverage 5 --stop-loss 62000
```

## 4. Run the API for your bot

Interactive (password typed once): `elyon serve`, e.g. inside `tmux`.

As a systemd user service (unattended — read [SECURITY.md](../SECURITY.md#unattended-mode) first):
```sh
printf '%s' 'your password' > ~/.config/elyon/password && chmod 600 ~/.config/elyon/password
mkdir -p ~/.config/systemd/user
cat > ~/.config/systemd/user/elyon.service <<'UNIT'
[Unit]
Description=elyon trading client API
After=network-online.target

[Service]
Environment=ELYON_PASSWORD_FILE=%h/.config/elyon/password
ExecStart=%h/.local/bin/elyon serve --auto-lock 12h
Restart=on-failure
RestartSec=10
NoNewPrivileges=true
PrivateTmp=true

[Install]
WantedBy=default.target
UNIT
systemctl --user daemon-reload
systemctl --user enable --now elyon
loginctl enable-linger "$USER"     # keep it running after you log out
journalctl --user -u elyon -f      # logs
```
Your bot: `ELYON_TOKEN=$(elyon api-token show)`, then call `http://127.0.0.1:7457` (see
[examples.md](examples.md)).

## Firewall

The API listens on 127.0.0.1 only; nothing to open. If you deliberately use `--listen 0.0.0.0:7457`, also
use `--allow-ip` and a firewall rule, and preferably TLS (`--tls-cert`, `--tls-key`).

## Update / uninstall

Replace the binary (the wallet in `~/.config/elyon` is kept); `systemctl --user restart elyon`. To remove:
withdraw funds, `systemctl --user disable --now elyon`, delete the binary and — only with your 24 words on
paper — `~/.config/elyon`.
