package cli

import (
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"strconv"
	"strings"
	"time"

	"github.com/elyon-chain/elyon-bot/internal/apitoken"
	"github.com/elyon-chain/elyon-bot/internal/app"
	"github.com/elyon-chain/elyon-bot/internal/errs"
	"github.com/elyon-chain/elyon-bot/internal/keystore"
)

const rule = "────────────────────────────────────────────────────────────────────"

func requireTerminal(what string) error {
	if !stdinIsTerminal() || !stdoutIsTerminal() {
		return errs.Newf(errs.TerminalRequired, "%s needs an interactive terminal (it shows or asks for secrets).", what).
			WithHint("Run it directly in a terminal window (with Docker: docker exec -it <container> elyon …).")
	}
	return nil
}

// backupFlow shows the recovery secret once, clears the screen and asks a short quiz.
func backupFlow(u *keystore.Unlocked) error {
	if err := requireTerminal("Showing the recovery phrase"); err != nil {
		return err
	}
	items := keystore.QuizItems(u.File.Kind, u.Secret())
	what := "recovery phrase (24 words)"
	if u.File.Kind == keystore.KindPrivateKey {
		what = "private key (16 groups of 4 characters)"
	}
	fmt.Println(rule)
	fmt.Printf("  YOUR %s\n", strings.ToUpper(what))
	fmt.Println("  Write it on paper, in this order, and keep it offline and private.")
	fmt.Println("  Anyone who sees it can take everything in this wallet. Elyon will never ask for it.")
	fmt.Println("  Do not photograph it, do not paste it into chats, e-mails or websites.")
	fmt.Println(rule)
	if err := u.RecordReveal(time.Now()); err != nil {
		return err
	}
	cols := 4
	rows := (len(items) + cols - 1) / cols
	for r := 0; r < rows; r++ {
		for c := 0; c < cols; c++ {
			i := c*rows + r
			if i < len(items) {
				fmt.Printf("  %2d. %-12s", i+1, items[i])
			}
		}
		fmt.Println()
	}
	fmt.Println(rule)
	if _, err := readLine("Press Enter when everything is written down (the screen will be cleared)… "); err != nil {
		return err
	}
	clearScreen()
	pos, err := keystore.PickPositions(3, len(items))
	if err != nil {
		return err
	}
	unit := "word"
	if u.File.Kind == keystore.KindPrivateKey {
		unit = "group"
	}
	fmt.Printf("Let's check your copy: type %s number %d, %d and %d from your paper (input is hidden).\n", unit, pos[0], pos[1], pos[2])
	answers := make([]string, len(pos))
	for i, p := range pos {
		ok := false
		for attempt := 1; attempt <= 3 && !ok; attempt++ {
			b, err := readHidden(fmt.Sprintf("%s #%d", capitalize(unit), p))
			if err != nil {
				return err
			}
			answers[i] = string(b)
			ok = keystore.CheckAnswers(items, []int{p}, []string{answers[i]})
			if !ok && attempt < 3 {
				fmt.Fprintf(os.Stderr, "  That is not %s #%d. Look at your paper and try again (attempt %d of 3).\n", unit, p, attempt+1)
			}
		}
		if !ok {
			fmt.Fprintln(os.Stderr, "\nThe backup is NOT confirmed. Run `elyon wallet backup` again and copy the words carefully.")
			return errs.New(errs.InvalidInput, "Backup quiz failed.")
		}
	}
	if !keystore.CheckAnswers(items, pos, answers) {
		return errs.New(errs.InvalidInput, "Backup quiz failed.")
	}
	if err := u.MarkBackupConfirmed(time.Now()); err != nil {
		return err
	}
	fmt.Println("\n✓ Backup confirmed. The recovery phrase will not be shown again (unless you insist with --show-again-i-understand-the-risk).")
	fmt.Println("  With it you can restore this wallet on any computer: `elyon wallet restore` (it also imports into MetaMask).")
	return nil
}

func walletBackup(a *app.App, p app.Params) error {
	f, err := a.WalletFile()
	if err != nil {
		return err
	}
	again, _ := p.Bool("show_again_i_understand_the_risk")
	if f.Meta.Backup.Confirmed && !again {
		when := ""
		if f.Meta.Backup.ConfirmedAt != nil {
			when = " on " + f.Meta.Backup.ConfirmedAt.Format("2006-01-02")
		}
		return errs.Newf(errs.BackupLocked, "Your backup was already confirmed%s, so the recovery secret is not shown again.", when).
			WithHint("Only if you really must see it again (for example to make a second paper copy), run: elyon wallet backup --show-again-i-understand-the-risk")
	}
	if err := requireTerminal("wallet backup"); err != nil {
		return err
	}
	if again {
		fmt.Fprintln(os.Stderr, "DANGER: you are about to display the secret that controls all funds of this wallet. Make sure nobody and no camera can see your screen.")
		if ans, _ := readLine("Type SHOW to continue: "); ans != "SHOW" {
			return errs.New(errs.InvalidInput, "Cancelled.")
		}
	}
	pw, err := readHidden("Wallet password")
	if err != nil {
		return err
	}
	u, err := f.Unlock(pw, time.Now(), keystore.UnlockOptions{KeepSecret: true})
	if err != nil {
		return mapKeystoreErr(err)
	}
	defer u.Wipe()
	return backupFlow(u)
}

func mapKeystoreErr(err error) error {
	switch {
	case errors.Is(err, keystore.ErrWrongPassword):
		return errs.New(errs.WrongPassword, "Wrong password.")
	case errors.Is(err, keystore.ErrPasswordExpired):
		return errs.New(errs.PasswordExpired, "Your password has expired.").WithHint("Run `elyon password change` first.")
	case errors.Is(err, keystore.ErrTampered):
		return errs.New(errs.WalletTampered, err.Error())
	case errors.Is(err, keystore.ErrWalletExists):
		return errs.New(errs.InvalidInput, err.Error())
	}
	return err
}

func walletCreate(a *app.App) error {
	if keystore.Exists(a.Home) {
		return mapKeystoreErr(keystore.ErrWalletExists)
	}
	pw, err := newPassword(true)
	if err != nil {
		return err
	}
	fmt.Fprintln(os.Stderr, "Creating the wallet (deriving the encryption key takes a second)…")
	u, err := keystore.Create(a.Home, pw, time.Now())
	if err != nil {
		return mapKeystoreErr(err)
	}
	defer u.Wipe()
	fmt.Printf("\nNew wallet created. Address on ElyonChain:\n\n  %s\n\n", u.Address.Hex())
	if stdinIsTerminal() && stdoutIsTerminal() {
		fmt.Println("Now write down your recovery phrase. You get it only this once.")
		if err := backupFlow(u); err != nil {
			fmt.Fprintln(os.Stderr, "Run `elyon wallet backup` to try again; the wallet works, but without a backup a lost computer means lost funds.")
		}
	} else {
		fmt.Fprintln(os.Stderr, "IMPORTANT: the recovery phrase is not backed up yet. Run `elyon wallet backup` in a terminal as soon as possible.")
	}
	ensureToken(a)
	return nil
}

func walletRestore(a *app.App, p app.Params) error {
	if keystore.Exists(a.Home) {
		return mapKeystoreErr(keystore.ErrWalletExists)
	}
	usePK, _ := p.Bool("private_key")
	fromStdin, _ := p.Bool("from_stdin")
	var secret string
	if fromStdin || !stdinIsTerminal() {
		b, err := io.ReadAll(io.LimitReader(os.Stdin, 4096))
		if err != nil {
			return err
		}
		secret = strings.TrimSpace(string(b))
	} else if usePK {
		b, err := readHidden("Private key (64 hexadecimal characters, input hidden)")
		if err != nil {
			return err
		}
		secret = string(b)
	} else {
		fmt.Fprintln(os.Stderr, "Type your recovery phrase: the words separated by spaces, in order (input is hidden).")
		b, err := readHidden("Recovery phrase")
		if err != nil {
			return err
		}
		secret = string(b)
	}
	if secret == "" {
		return errs.New(errs.InvalidInput, "Nothing was entered.")
	}
	if !usePK {
		if _, err := keystore.NormalizeMnemonic(secret); err != nil {
			if _, kerr := keystore.KeyFromHex(secret); kerr == nil {
				usePK = true
			} else {
				return errs.New(errs.InvalidInput, capitalize(err.Error())+".")
			}
		}
	}
	pw, err := newPassword(true)
	if err != nil {
		return err
	}
	var u *keystore.Unlocked
	if usePK {
		u, err = keystore.ImportPrivateKey(a.Home, secret, pw, time.Now())
	} else {
		u, err = keystore.ImportMnemonic(a.Home, secret, pw, time.Now())
	}
	secret = ""
	if err != nil {
		return mapKeystoreErr(err)
	}
	defer u.Wipe()
	fmt.Printf("Wallet restored. Address on ElyonChain:\n\n  %s\n\nCheck that this is the address you expect before sending funds.\n", u.Address.Hex())
	ensureToken(a)
	return nil
}

func passwordChange(a *app.App) error {
	if err := requireTerminal("password change"); err != nil {
		return err
	}
	f, err := a.WalletFile()
	if err != nil {
		return err
	}
	old, err := readHidden("Current password")
	if err != nil {
		return err
	}
	u, err := f.Unlock(old, time.Now(), keystore.UnlockOptions{AllowExpired: true})
	if err != nil {
		return mapKeystoreErr(err)
	}
	defer u.Wipe()
	pw, err := newPassword(false)
	if err != nil {
		return err
	}
	if err := u.ChangePassword(old, pw, time.Now()); err != nil {
		return errs.New(errs.PasswordWeak, capitalize(err.Error())+".")
	}
	st := u.File.Meta.PasswordStatus(time.Now())
	fmt.Printf("Password changed. It is valid until %s (%d days).\n", st.ExpiresAt.Format("2006-01-02"), st.MaxAgeDays)
	if findDaemon(a) != nil {
		fmt.Println("A daemon is running: it keeps working. If it was locked, run `elyon unlock` with the new password.")
	}
	return nil
}

func passwordPolicy(a *app.App, p app.Params) error {
	if err := requireTerminal("password policy"); err != nil {
		return err
	}
	n, err := strconv.Atoi(p.Str("max_age_days"))
	if err != nil || n < keystore.MinMaxAgeDays || n > keystore.MaxMaxAgeDays {
		return errs.Newf(errs.InvalidInput, "--max-age-days must be between %d and %d.", keystore.MinMaxAgeDays, keystore.MaxMaxAgeDays)
	}
	f, err := a.WalletFile()
	if err != nil {
		return err
	}
	pw, err := readHidden("Wallet password")
	if err != nil {
		return err
	}
	u, err := f.Unlock(pw, time.Now(), keystore.UnlockOptions{AllowExpired: true})
	if err != nil {
		return mapKeystoreErr(err)
	}
	defer u.Wipe()
	u.File.Meta.PasswordMaxAgeDays = n
	if err := u.SaveMeta(); err != nil {
		return err
	}
	st := u.File.Meta.PasswordStatus(time.Now())
	fmt.Printf("Passwords now stay valid for %d days. The current one expires %s.\n", n, st.ExpiresAt.Format("2006-01-02"))
	return nil
}

func ensureToken(a *app.App) {
	_, created, err := apitoken.Ensure(a.Home)
	if err != nil {
		fmt.Fprintln(os.Stderr, "Could not create the API token:", err)
		return
	}
	if created {
		fmt.Printf("\nA secret API token for bots was created in %s (show it with `elyon api-token show`).\n", apitoken.Path(a.Home))
	}
}

func setup(a *app.App) error {
	fmt.Println("Welcome to elyon, the command-line trading client for the Elyon DEX.")
	fmt.Println("Your key is created and kept on this computer only, encrypted with your password. Elyon never sees it.")
	fmt.Printf("Data folder: %s\n\n", a.Home)
	if keystore.Exists(a.Home) {
		f, err := a.WalletFile()
		if err != nil {
			return err
		}
		fmt.Printf("A wallet already exists here: %s\n", f.Address)
		if !f.Meta.Backup.Confirmed {
			fmt.Println("Its recovery phrase is not backed up yet.")
			if err := walletBackup(a, app.Params{}); err != nil {
				return err
			}
		}
		ensureToken(a)
		nextSteps(f.Address)
		return nil
	}
	if err := requireTerminal("elyon setup"); err != nil {
		return err
	}
	fmt.Println("  1) Create a new wallet (recommended for a trading bot)")
	fmt.Println("  2) Restore a wallet from its recovery phrase or private key")
	var choice string
	for choice != "1" && choice != "2" {
		var err error
		if choice, err = readLine("Choose 1 or 2: "); err != nil {
			return err
		}
	}
	var err error
	if choice == "1" {
		err = walletCreate(a)
	} else {
		err = walletRestore(a, app.Params{})
	}
	if err != nil {
		return err
	}
	f, err := a.WalletFile()
	if err != nil {
		return err
	}
	nextSteps(f.Address)
	return nil
}

func nextSteps(addr string) {
	fmt.Printf(`
Next steps
  1. On the DEX website, deposit USDT the usual way to get wUSDT.
  2. From your DEX wallet, send wUSDT (for trading) and a little ELN (for network fees,
     0.1–0.3 ELN is plenty) to this client's address:
         %s
  3. Check:            elyon wallet balance
  4. Start the API:    elyon serve          (your bot then calls http://127.0.0.1:7457)
     or trade directly: elyon futures open long BTC --margin 10 --leverage 5
  Help: elyon help    ·    Docs: README.md, docs/commands.md, docs/http-api.md
`, addr)
}

func apiTokenShow(a *app.App, rotate bool) error {
	var t string
	var err error
	if rotate {
		t, err = apitoken.Rotate(a.Home)
		if err == nil {
			fmt.Fprintln(os.Stderr, "New API token created. The old one stops working immediately (a running daemon picks the new one up by itself).")
		}
	} else {
		var created bool
		t, created, err = apitoken.Ensure(a.Home)
		if created {
			fmt.Fprintln(os.Stderr, "A new API token was created.")
		}
	}
	if err != nil {
		return err
	}
	fmt.Fprintf(os.Stderr, "Keep it secret: it lets programs on this computer trade with your wallet. File: %s\n", apitoken.Path(a.Home))
	fmt.Println(t)
	return nil
}

func configShow(a *app.App) error {
	b, _ := json.MarshalIndent(a.Cfg, "", "  ")
	fmt.Fprintf(os.Stderr, "Configuration file: %s (built-in defaults are used for anything not in the file)\n", a.Cfg.FilePath())
	fmt.Println(string(b))
	return nil
}
