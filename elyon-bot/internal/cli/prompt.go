package cli

import (
	"bufio"
	"context"
	"fmt"
	"os"
	"runtime"
	"strings"
	"sync"

	"golang.org/x/term"

	"github.com/elyon-chain/elyon-bot/internal/errs"
	"github.com/elyon-chain/elyon-bot/internal/keystore"
)

// stdinIsTerminal reports whether a human can type answers.
func stdinIsTerminal() bool { return term.IsTerminal(int(os.Stdin.Fd())) }

func stdoutIsTerminal() bool { return term.IsTerminal(int(os.Stdout.Fd())) }

var (
	warnOnce sync.Once
	stdinRd  = bufio.NewReader(os.Stdin)
)

// passwordFromEnvironment implements the documented, opt-in unattended mode: ELYON_PASSWORD_FILE (a file holding
// the password) or ELYON_PASSWORD. Both print a warning every time they are used.
func passwordFromEnvironment() ([]byte, bool, error) {
	if p := strings.TrimSpace(os.Getenv("ELYON_PASSWORD_FILE")); p != "" {
		b, err := os.ReadFile(p)
		if err != nil {
			return nil, true, errs.Newf(errs.PasswordRequired, "Cannot read ELYON_PASSWORD_FILE (%s): %v", p, err)
		}
		if runtime.GOOS != "windows" {
			if st, err := os.Stat(p); err == nil && st.Mode().Perm()&0o077 != 0 {
				fmt.Fprintf(os.Stderr, "WARNING: %s is readable by other users (mode %o). Run: chmod 600 %s\n", p, st.Mode().Perm(), p)
			}
		}
		warnOnce.Do(func() {
			fmt.Fprintln(os.Stderr, "WARNING: using the wallet password from ELYON_PASSWORD_FILE (unattended mode). Anyone who can read that file can use your wallet. See SECURITY.md.")
		})
		return []byte(strings.TrimRight(string(b), "\r\n")), true, nil
	}
	if p, ok := os.LookupEnv("ELYON_PASSWORD"); ok && p != "" {
		warnOnce.Do(func() {
			fmt.Fprintln(os.Stderr, "WARNING: using the wallet password from the ELYON_PASSWORD environment variable (unattended mode). Other programs of this user can read it. Prefer ELYON_PASSWORD_FILE. See SECURITY.md.")
		})
		return []byte(p), true, nil
	}
	return nil, false, nil
}

// askPassword asks for an existing password: environment opt-in first, then the terminal (hidden input).
func askPassword(ctx context.Context, why string) ([]byte, error) {
	if pw, ok, err := passwordFromEnvironment(); ok {
		return pw, err
	}
	return readHidden(why)
}

// readHidden reads one line without echo from the terminal.
func readHidden(prompt string) ([]byte, error) {
	if !stdinIsTerminal() {
		return nil, errs.New(errs.TerminalRequired, "No terminal to ask for the wallet password.").
			WithHint("Run the command in a terminal, start the daemon (`elyon serve`) and send commands to it, or use the unattended mode with ELYON_PASSWORD_FILE (see SECURITY.md).")
	}
	b, err := readSecret(int(os.Stdin.Fd()), prompt+": ", os.Stderr)
	if err != nil {
		return nil, errs.Newf(errs.TerminalRequired, "Could not read from the terminal: %v", err)
	}
	return b, nil
}

// newPassword asks for a new password twice and enforces the policy. The unattended file is accepted (with a
// warning) only when allowEnv is true.
func newPassword(allowEnv bool) ([]byte, error) {
	if allowEnv {
		if pw, ok, err := passwordFromEnvironment(); ok {
			if err != nil {
				return nil, err
			}
			if err := keystore.ValidatePassword(pw); err != nil {
				return nil, errs.New(errs.PasswordWeak, "The password from the environment is too weak: "+err.Error())
			}
			return pw, nil
		}
	}
	fmt.Fprintf(os.Stderr, "Choose a password of at least %d characters (a short sentence is easy to remember and hard to guess).\nIt protects the key on this computer and must be changed every %d days by default.\n", keystore.MinPasswordLength, keystore.DefaultMaxAgeDays)
	for attempt := 0; attempt < 3; attempt++ {
		pw, err := readHidden("New password")
		if err != nil {
			return nil, err
		}
		if err := keystore.ValidatePassword(pw); err != nil {
			fmt.Fprintln(os.Stderr, "  "+capitalize(err.Error())+".")
			continue
		}
		again, err := readHidden("Repeat the new password")
		if err != nil {
			return nil, err
		}
		if string(again) != string(pw) {
			fmt.Fprintln(os.Stderr, "  The two passwords are different. Try again.")
			continue
		}
		return pw, nil
	}
	return nil, errs.New(errs.PasswordWeak, "No valid password was chosen.")
}

func capitalize(s string) string {
	if s == "" {
		return s
	}
	return strings.ToUpper(s[:1]) + s[1:]
}

// readLine reads a visible line from standard input.
func readLine(prompt string) (string, error) {
	if prompt != "" {
		fmt.Fprint(os.Stderr, prompt)
	}
	s, err := stdinRd.ReadString('\n')
	if err != nil && s == "" {
		return "", errs.Newf(errs.TerminalRequired, "Could not read your answer: %v", err)
	}
	return strings.TrimSpace(s), nil
}

// clearScreen erases the screen and the scroll-back so a recovery phrase does not stay visible.
func clearScreen() {
	enableVirtualTerminal()
	fmt.Fprint(os.Stdout, "\033[H\033[2J\033[3J")
	fmt.Fprint(os.Stdout, strings.Repeat("\n", 60))
	fmt.Fprint(os.Stdout, "\033[H\033[2J\033[3J")
}
