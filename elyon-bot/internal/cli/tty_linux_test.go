//go:build linux

package cli

import (
	"encoding/json"
	"fmt"
	"os"
	"os/exec"
	"strings"
	"sync"
	"syscall"
	"testing"
	"time"

	"golang.org/x/sys/unix"

	"github.com/elyon-chain/elyon-bot/internal/keystore"
)

const testPassword = "pty test passphrase 314"

// openPTY allocates a pseudo-terminal pair.
func openPTY(t *testing.T) (master, slave *os.File) {
	t.Helper()
	m, err := os.OpenFile("/dev/ptmx", os.O_RDWR|unix.O_NOCTTY|unix.O_CLOEXEC, 0)
	if err != nil {
		t.Skipf("no pseudo-terminal available: %v", err)
	}
	if err := unix.IoctlSetPointerInt(int(m.Fd()), unix.TIOCSPTLCK, 0); err != nil {
		t.Skipf("cannot unlock pty: %v", err)
	}
	n, err := unix.IoctlGetInt(int(m.Fd()), unix.TIOCGPTN)
	if err != nil {
		t.Skipf("cannot get pty number: %v", err)
	}
	s, err := os.OpenFile(fmt.Sprintf("/dev/pts/%d", n), os.O_RDWR|unix.O_NOCTTY, 0)
	if err != nil {
		t.Skipf("cannot open pty slave: %v", err)
	}
	return m, s
}

// screen collects everything the terminal displays (the master side).
type screen struct {
	mu  sync.Mutex
	buf strings.Builder
}

func (s *screen) collect(m *os.File) {
	b := make([]byte, 4096)
	for {
		n, err := m.Read(b)
		if n > 0 {
			s.mu.Lock()
			s.buf.Write(b[:n])
			s.mu.Unlock()
		}
		if err != nil {
			return
		}
	}
}

func (s *screen) String() string { s.mu.Lock(); defer s.mu.Unlock(); return s.buf.String() }

func (s *screen) waitFor(t *testing.T, text string, d time.Duration) {
	t.Helper()
	end := time.Now().Add(d)
	for time.Now().Before(end) {
		if strings.Contains(s.String(), text) {
			return
		}
		time.Sleep(20 * time.Millisecond)
	}
	t.Fatalf("timeout waiting for %q; screen:\n%s", text, s.String())
}

// The hidden reader must never echo, must discard what was typed before the prompt, and must restore echo.
func TestReadSecretNoEchoAndTypeAheadDiscarded(t *testing.T) {
	m, s := openPTY(t)
	defer m.Close()
	defer s.Close()
	var scr screen
	go scr.collect(m)

	fd := int(s.Fd())
	_, _ = m.Write([]byte("typed-before-the-prompt\n")) // type-ahead: shown in clear by the terminal, must not be used
	scr.waitFor(t, "typed-before-the-prompt", 3*time.Second)

	type result struct {
		b   []byte
		err error
	}
	done := make(chan result, 1)
	go func() {
		b, err := readSecret(fd, "Secret: ", s)
		done <- result{b, err}
	}()
	scr.waitFor(t, "Secret: ", 3*time.Second)
	before := len(scr.String())
	_, _ = m.Write([]byte("the real secret\n"))
	var r result
	select {
	case r = <-done:
	case <-time.After(5 * time.Second):
		t.Fatal("readSecret did not return")
	}
	if r.err != nil || string(r.b) != "the real secret" {
		t.Fatalf("got %q %v, want the line typed after the prompt (type-ahead must be discarded)", r.b, r.err)
	}
	time.Sleep(100 * time.Millisecond)
	if after := scr.String()[before:]; strings.Contains(after, "the real secret") {
		t.Fatalf("the secret was echoed: %q", after)
	}
	st, err := unix.IoctlGetTermios(fd, unix.TCGETS)
	if err != nil || st.Lflag&unix.ECHO == 0 {
		t.Fatalf("echo not restored after the prompt (lflag %x, %v)", st.Lflag, err)
	}
}

// runCLI runs `elyon <args>` (this test binary in CLI mode) on a fresh pseudo-terminal with no network.
func runCLI(t *testing.T, home string, typeAhead string, password string, wantPrompt string, args ...string) string {
	t.Helper()
	m, s := openPTY(t)
	defer m.Close()
	var scr screen
	go scr.collect(m)
	argv, _ := json.Marshal(args)
	cmd := exec.Command(os.Args[0])
	cmd.Env = []string{"ELYON_CLI_TEST_MAIN=1", "ELYON_CLI_TEST_ARGS=" + string(argv), "HOME=" + home, "TERM=xterm",
		"ELYON_RPC_URL=http://127.0.0.1:1", "ELYON_API_URL=http://127.0.0.1:1", "PATH=/usr/bin:/bin"}
	cmd.Stdin, cmd.Stdout, cmd.Stderr = s, s, s
	cmd.SysProcAttr = &syscall.SysProcAttr{Setsid: true, Setctty: true, Ctty: 0}
	if err := cmd.Start(); err != nil {
		t.Fatal(err)
	}
	s.Close()
	if typeAhead != "" {
		_, _ = m.Write([]byte(typeAhead + "\n")) // typed before the program asks (e.g. while it starts)
	}
	scr.waitFor(t, wantPrompt, 20*time.Second)
	time.Sleep(1200 * time.Millisecond) // like a person: type well after the prompt appeared
	for _, c := range password + "\n" {
		_, _ = m.Write([]byte(string(c)))
		time.Sleep(15 * time.Millisecond)
	}
	waited := make(chan error, 1)
	go func() { waited <- cmd.Wait() }()
	select {
	case <-waited:
	case <-time.After(60 * time.Second):
		_ = cmd.Process.Kill()
		t.Fatalf("elyon %v did not finish; screen:\n%s", args, scr.String())
	}
	time.Sleep(100 * time.Millisecond)
	out := scr.String()
	if strings.Contains(out, password) {
		t.Fatalf("elyon %v ECHOED the password; screen:\n%s", args, out)
	}
	return out
}

func newTestWallet(t *testing.T) string {
	t.Helper()
	keystore.ScryptN = 1 << 14
	home := t.TempDir()
	if _, err := keystore.ImportMnemonic(home, "test test test test test test test test test test test junk", []byte(testPassword), time.Now()); err != nil {
		t.Fatal(err)
	}
	return home
}

// Regression for the report "elyon serve echoes the wallet password": the prompt comes before any network
// activity, nothing typed is echoed, and a password typed before the prompt is never used.
func TestServePromptHidesPassword(t *testing.T) {
	home := newTestWallet(t)
	out := runCLI(t, home, "early-typed-wrong-guess", testPassword, "Wallet password (unlocks trading for this session): ", "--home", home, "serve")
	if strings.Contains(out, "Wrong password") {
		t.Fatalf("the text typed before the prompt was used as the password:\n%s", out)
	}
	// Unlocking worked; the (deliberately unreachable) RPC is only contacted after the password.
	if !strings.Contains(out, "RPC") {
		t.Fatalf("expected the network error after a successful unlock:\n%s", out)
	}
}

// One-shot commands that sign ask for the password at once, before any network work, without echo.
func TestOneShotTradePromptHidesPassword(t *testing.T) {
	home := newTestWallet(t)
	out := runCLI(t, home, "", testPassword, "Wallet password: ", "--home", home, "futures", "close", "7")
	if !strings.Contains(out, "DEX API") {
		t.Fatalf("expected the DEX API error after the prompt:\n%s", out)
	}
}

// Password-gated settings (approve a destination) use the same hidden prompt.
func TestWalletAllowPromptHidesPassword(t *testing.T) {
	home := newTestWallet(t)
	out := runCLI(t, home, "", testPassword, "Wallet password: ", "--home", home, "wallet", "allow", "0x0E0bB1BDEc7248eBac6eFBE624ceAEd86bda3e27")
	if !strings.Contains(out, "Approved 0x0E0bB1BDEc7248eBac6eFBE624ceAEd86bda3e27") {
		t.Fatalf("allow did not complete:\n%s", out)
	}
}
