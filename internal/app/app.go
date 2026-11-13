// Package app implements every elyon command once; the CLI (internal/cli) and the HTTP API (internal/server)
// are thin front ends over it, so both offer exactly the same commands, parameters and results.
package app

import (
	"context"
	"crypto/ecdsa"
	"errors"
	"fmt"
	"math/big"
	"strings"
	"sync"
	"time"

	"github.com/ethereum/go-ethereum/common"

	"github.com/elyon-chain/elyon-bot/internal/amount"
	"github.com/elyon-chain/elyon-bot/internal/audit"
	"github.com/elyon-chain/elyon-bot/internal/chain"
	"github.com/elyon-chain/elyon-bot/internal/config"
	"github.com/elyon-chain/elyon-bot/internal/dex"
	"github.com/elyon-chain/elyon-bot/internal/errs"
	"github.com/elyon-chain/elyon-bot/internal/guard"
	"github.com/elyon-chain/elyon-bot/internal/keystore"
)

// Mode is how the process runs.
const (
	ModeCLI    = "cli"
	ModeDaemon = "daemon"
)

// PasswordFunc obtains the wallet password from the user (terminal prompt, or the opt-in password file).
type PasswordFunc func(ctx context.Context, why string) ([]byte, error)

// App is one elyon process: configuration, connections and (maybe) an unlocked key.
type App struct {
	Home string
	Cfg  *config.Config
	Mode string

	// AskPassword is set by the CLI; the daemon leaves it nil (passwords then come with the request).
	AskPassword PasswordFunc
	// Progress receives short notes while a command runs ("Approving wUSDT…"); may be nil.
	Progress func(string)
	Audit    *audit.Logger
	Session  *Session
	Ledger   *guard.Ledger
	Now      func() time.Time

	mu         sync.Mutex
	chain      *chain.Client
	dexc       *dex.Client
	txMu       sync.Mutex
	feeders    map[common.Address]bool
	pwFailures []time.Time
}

// New creates an App for an elyon home directory.
func New(home string, cfg *config.Config, mode string) *App {
	return &App{Home: home, Cfg: cfg, Mode: mode, Audit: audit.New(home), Session: &Session{}, Ledger: guard.LoadLedger(home), Now: time.Now, feeders: map[common.Address]bool{}}
}

// Chain returns the RPC client, connecting on first use.
func (a *App) Chain(ctx context.Context) (*chain.Client, error) {
	a.mu.Lock()
	defer a.mu.Unlock()
	if a.chain != nil {
		return a.chain, nil
	}
	c, err := chain.Dial(ctx, a.Cfg.RPCURL)
	if err != nil {
		return nil, err
	}
	a.chain = c
	return c, nil
}

// DEX returns the DEX API client.
func (a *App) DEX() *dex.Client {
	a.mu.Lock()
	defer a.mu.Unlock()
	if a.dexc == nil {
		a.dexc = dex.New(a.Cfg.APIURL)
	}
	return a.dexc
}

// WalletFile loads wallet.json.
func (a *App) WalletFile() (*keystore.File, error) {
	f, err := keystore.Load(a.Home)
	if errors.Is(err, keystore.ErrNoWallet) {
		return nil, errs.New(errs.WalletMissing, "There is no wallet in "+a.Home+" yet.").WithHint("Create one with `elyon setup` (or restore one with `elyon wallet restore`).")
	}
	if err != nil {
		return nil, errs.New(errs.WalletTampered, err.Error())
	}
	return f, nil
}

// Explorer returns the explorer URL of a transaction.
func (a *App) Explorer(hash string) string { return a.Cfg.ExplorerURL + "/tx/" + hash }

// ---------------------------------------------------------------- session

// Session holds the unlocked key of the daemon (or of one CLI command).
type Session struct {
	mu       sync.Mutex
	u        *keystore.Unlocked
	lastUsed time.Time
}

// Set stores an unlocked wallet (replacing and wiping a previous one).
func (s *Session) Set(u *keystore.Unlocked) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.u != nil && s.u != u {
		s.u.Wipe()
	}
	s.u = u
	s.lastUsed = time.Now()
}

// Get returns the unlocked wallet (nil when locked) and marks it used.
func (s *Session) Get() *keystore.Unlocked {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.u != nil {
		s.lastUsed = time.Now()
	}
	return s.u
}

// Peek returns the unlocked wallet without touching the idle timer.
func (s *Session) Peek() *keystore.Unlocked {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.u
}

// Lock wipes the key from memory.
func (s *Session) Lock() {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.u != nil {
		s.u.Wipe()
		s.u = nil
	}
}

// Unlocked reports whether a key is held.
func (s *Session) Unlocked() bool { return s.Peek() != nil }

// IdleFor is the time since the key was last used.
func (s *Session) IdleFor() time.Duration {
	s.mu.Lock()
	defer s.mu.Unlock()
	return time.Since(s.lastUsed)
}

// ---------------------------------------------------------------- password attempts

const (
	maxPasswordFailures = 5
	passwordWindow      = 15 * time.Minute
)

func (a *App) passwordBlocked() error {
	a.mu.Lock()
	defer a.mu.Unlock()
	now := a.Now()
	keep := a.pwFailures[:0]
	for _, t := range a.pwFailures {
		if now.Sub(t) < passwordWindow {
			keep = append(keep, t)
		}
	}
	a.pwFailures = keep
	if len(keep) >= maxPasswordFailures {
		wait := passwordWindow - now.Sub(keep[0])
		return errs.Newf(errs.TooManyAttempts, "Too many wrong passwords. Password checks are blocked for %d more minutes.", int(wait.Minutes())+1)
	}
	return nil
}

func (a *App) passwordFailed() {
	a.mu.Lock()
	a.pwFailures = append(a.pwFailures, a.Now())
	a.mu.Unlock()
}

// Unlock decrypts the wallet with password and keeps it in the session.
func (a *App) Unlock(password []byte) (*keystore.Unlocked, error) {
	if err := a.passwordBlocked(); err != nil {
		return nil, err
	}
	f, err := a.WalletFile()
	if err != nil {
		return nil, err
	}
	u, err := f.Unlock(password, a.Now(), keystore.UnlockOptions{})
	if err != nil {
		return nil, a.mapUnlockErr(err)
	}
	a.Session.Set(u)
	return u, nil
}

// VerifyPassword checks a password (attempt-limited) without unlocking.
func (a *App) VerifyPassword(password []byte) error {
	if err := a.passwordBlocked(); err != nil {
		return err
	}
	f, err := a.WalletFile()
	if err != nil {
		return err
	}
	if err := f.VerifyPassword(password); err != nil {
		return a.mapUnlockErr(err)
	}
	return nil
}

func (a *App) mapUnlockErr(err error) error {
	switch {
	case errors.Is(err, keystore.ErrWrongPassword):
		a.passwordFailed()
		return errs.New(errs.WrongPassword, "Wrong password.")
	case errors.Is(err, keystore.ErrPasswordExpired):
		return errs.New(errs.PasswordExpired, "Your password has expired, so the wallet stays locked.").WithHint("Run `elyon password change` (it asks for the old password), then unlock again.")
	case errors.Is(err, keystore.ErrTampered):
		return errs.New(errs.WalletTampered, keystore.ErrTampered.Error())
	}
	return errs.As(err)
}

// ---------------------------------------------------------------- per-command context

// Request describes who sent a command.
type Request struct {
	Source   string // cli, http, batch
	ClientIP string
}

// Ctx is passed to command handlers.
type Ctx struct {
	*App
	Cmd *Command
	P   Params
	Req Request
	res *Result
	// pwVerified is true once the wallet password was supplied with this command and checked.
	pwVerified bool
}

// Note reports progress.
func (x *Ctx) Note(format string, a ...any) {
	if x.Progress != nil {
		x.Progress(fmt.Sprintf(format, a...))
	}
}

// Warn adds a warning to the result.
func (x *Ctx) Warn(msg string) { x.res.Warnings = append(x.res.Warnings, msg) }

// Address returns the wallet address (from the unlocked key if available, else from wallet.json).
func (x *Ctx) Address() (common.Address, error) {
	if u := x.Session.Peek(); u != nil {
		return u.Address, nil
	}
	f, err := x.WalletFile()
	if err != nil {
		return common.Address{}, err
	}
	return f.AddressValue(), nil
}

// password returns the password given with the request ("password" parameter) or asks the CLI user.
func (x *Ctx) password(why string) ([]byte, error) {
	if pw := x.P["password"]; pw != "" {
		return []byte(pw), nil
	}
	if x.AskPassword != nil {
		return x.AskPassword(context.Background(), why)
	}
	return nil, errs.New(errs.PasswordRequired, "This action needs the wallet password.").WithHint("Send it in the \"password\" field of the request.")
}

// RequirePassword asks for and verifies the password.
func (x *Ctx) RequirePassword(why string) ([]byte, error) {
	pw, err := x.password(why)
	if err != nil {
		return nil, err
	}
	if err := x.VerifyPassword(pw); err != nil {
		return nil, err
	}
	x.pwVerified = true
	return pw, nil
}

// Unlocked returns the unlocked wallet, unlocking it in CLI mode by asking for the password.
func (x *Ctx) Unlocked() (*keystore.Unlocked, error) {
	if u := x.Session.Get(); u != nil {
		return u, nil
	}
	if x.Mode == ModeDaemon {
		return nil, errs.New(errs.WalletLocked, "The wallet is locked.").WithHint("Unlock it with `elyon unlock` (or POST /v1/unlock with the password).")
	}
	pw, err := x.password("Wallet password")
	if err != nil {
		return nil, err
	}
	u, err := x.Unlock(pw)
	if err == nil {
		x.pwVerified = true
	}
	return u, err
}

// Key returns the private key for signing.
func (x *Ctx) Key() (*ecdsa.PrivateKey, error) {
	u, err := x.Unlocked()
	if err != nil {
		return nil, err
	}
	return u.Key, nil
}

// Send signs and sends a transaction and records it in the result.
func (x *Ctx) Send(ctx context.Context, req chain.TxRequest) (*chain.TxResult, error) {
	key, err := x.Key()
	if err != nil {
		return nil, err
	}
	c, err := x.Chain(ctx)
	if err != nil {
		return nil, err
	}
	x.Note("Sending: %s…", req.Label)
	res, err := c.Send(ctx, key, req, x.Cfg.TxTimeout())
	if res != nil && res.Hash != (common.Hash{}) {
		x.res.Txs = append(x.res.Txs, res)
	}
	if err == nil {
		x.Note("Confirmed: %s (%s)", req.Label, res.Hash.Hex())
	}
	return res, err
}

// EnsureAllowance approves spender for at least need of token (exact amount unless unlimited).
func (x *Ctx) EnsureAllowance(ctx context.Context, token, spender common.Address, need *big.Int, symbol string, unlimited bool) error {
	c, err := x.Chain(ctx)
	if err != nil {
		return err
	}
	owner, err := x.Address()
	if err != nil {
		return err
	}
	have, err := c.Allowance(ctx, token, owner, spender)
	if err != nil {
		return err
	}
	if have.Cmp(need) >= 0 {
		return nil
	}
	value := need
	if unlimited {
		value = new(big.Int).Sub(new(big.Int).Lsh(big.NewInt(1), 256), big.NewInt(1))
	}
	label := fmt.Sprintf("approve %s for %s", symbol, contractName(x.Cfg, spender))
	_, err = x.Send(ctx, chain.TxRequest{To: token, Data: chain.Pack(chain.ERC20ABI, "approve", spender, value), Label: label, Revert: chain.RevertContext{"symbol": symbol}})
	return err
}

// contractName names a pinned contract for messages.
func contractName(cfg *config.Config, a common.Address) string {
	k := cfg.Contracts
	switch a {
	case config.Addr(k.Router):
		return "the spot router"
	case config.Addr(k.PerpTriggers):
		return "the futures contract"
	case config.Addr(k.PerpLimitRouter):
		return "the futures limit-order contract"
	case config.Addr(k.GasSale):
		return "the ELN gas sale"
	}
	return a.Hex()
}

// ---------------------------------------------------------------- running a command

// Run executes a command with access checks, warnings and auditing.
func (a *App) Run(ctx context.Context, cmd *Command, p Params, req Request) (res *Result, err error) {
	start := time.Now()
	res = &Result{}
	x := &Ctx{App: a, Cmd: cmd, P: p, Req: req, res: res}
	defer func() {
		if r := recover(); r != nil {
			err = errs.Newf(errs.Internal, "Internal error in %s: %v", cmd.ID(), r)
		}
		a.audit(cmd, p, req, res, err, time.Since(start))
	}()
	if err := cmd.CheckKnown(p); err != nil {
		return res, err
	}
	if req.Source == "http" && cmd.CLIOnly {
		return res, errs.Newf(errs.NotAvailableHere, "`%s` is interactive and only available in a terminal: run `elyon %s`.", cmd.Name, cmd.Name)
	}
	if cmd.Access != Public {
		f, ferr := a.WalletFile()
		if ferr != nil {
			return res, ferr
		}
		st := f.Meta.PasswordStatus(a.Now())
		if w := st.WarningText(); w != "" && !st.Expired {
			x.Warn(w)
		}
		if cmd.Access == KeyNeeded && !f.Meta.Backup.Confirmed {
			x.Warn("Your recovery phrase is not backed up yet. Run `elyon wallet backup` in a terminal; without it a lost machine means lost funds.")
		}
	}
	if cmd.Access == KeyNeeded {
		if _, err := x.Unlocked(); err != nil {
			return res, err
		}
		// One signing command at a time per process: nonces and balance checks stay consistent.
		a.txMu.Lock()
		defer a.txMu.Unlock()
	}
	out, err := cmd.Run(ctx, x)
	if out != nil {
		out.Txs = append(res.Txs, out.Txs...)
		out.Warnings = append(res.Warnings, out.Warnings...)
		*res = *out
	}
	if err == nil && cmd.Access == KeyNeeded && len(res.Txs) > 0 {
		a.lowGasWarning(ctx, x)
	}
	return res, err
}

func (a *App) lowGasWarning(ctx context.Context, x *Ctx) {
	c, err := a.Chain(ctx)
	if err != nil {
		return
	}
	addr, err := x.Address()
	if err != nil {
		return
	}
	bal, err := c.NativeBalance(ctx, addr)
	if err == nil && bal.Cmp(big.NewInt(3_000_000_000_000_000)) < 0 {
		x.res.Warnings = append(x.res.Warnings, fmt.Sprintf("Low gas: the wallet holds only %s ELN. Send a little ELN to %s or run `elyon gas buy 0.5`.", amount.FormatSig(bal, 18, 4), addr.Hex()))
	}
}

func (a *App) audit(cmd *Command, p Params, req Request, res *Result, err error, d time.Duration) {
	if a.Audit == nil {
		return
	}
	e := audit.Entry{Source: req.Source, ClientIP: req.ClientIP, Command: cmd.ID(), Params: p, OK: err == nil, Millis: d.Milliseconds()}
	if err != nil {
		ue := errs.As(err)
		e.Error, e.Message = ue.Code, ue.Message
	}
	if res != nil {
		for _, t := range res.Txs {
			e.Txs = append(e.Txs, t.Hash.Hex())
		}
	}
	a.Audit.Write(e)
}

// TxViews renders transactions for output.
func (a *App) TxViews(txs []*chain.TxResult) []TxView {
	out := make([]TxView, 0, len(txs))
	for _, t := range txs {
		out = append(out, TxView{Label: t.Label, Hash: t.Hash.Hex(), Block: t.Block, GasUsed: t.GasUsed, FeeELN: t.Fee, Explorer: a.Explorer(t.Hash.Hex())})
	}
	return out
}

// shortHash abbreviates a hash for text output.
func shortHash(h string) string {
	if len(h) > 14 {
		return h[:10] + "…" + h[len(h)-4:]
	}
	return h
}

// line formats an aligned "label  value" row.
func line(label, value string) string { return fmt.Sprintf("  %-18s %s\n", label, value) }

// joinNonEmpty joins non-empty strings.
func joinNonEmpty(sep string, parts ...string) string {
	var out []string
	for _, p := range parts {
		if strings.TrimSpace(p) != "" {
			out = append(out, p)
		}
	}
	return strings.Join(out, sep)
}
