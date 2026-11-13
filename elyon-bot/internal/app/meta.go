package app

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"math/big"
	"os"
	"strings"
	"time"

	ethereum "github.com/ethereum/go-ethereum"
	"github.com/ethereum/go-ethereum/common"

	"github.com/elyon-chain/elyon-bot/internal/amount"
	"github.com/elyon-chain/elyon-bot/internal/config"
	"github.com/elyon-chain/elyon-bot/internal/errs"
	"github.com/elyon-chain/elyon-bot/internal/version"
)

func init() {
	register(
		&Command{Name: "status", Summary: "Show the network, the DEX API, the wallet, the password age and the main balances.", Usage: "status", Access: Public, ReadOnly: true, Run: statusCmd},
		&Command{Name: "portfolio", Summary: "One snapshot of everything: balances, open positions with PnL and open orders.", Usage: "portfolio", Access: AddressOnly, ReadOnly: true, Run: portfolioCmd},
		&Command{Name: "tx", Summary: "Check a transaction: pending, confirmed or reverted.", Usage: "tx <hash>", Access: Public, ReadOnly: true, Run: txCmd,
			Params: []Param{{Name: "hash"}}, Positional: fill("hash")},
		&Command{Name: "version", Summary: "Show the version of elyon.", Usage: "version", Access: Public, ReadOnly: true, Run: func(ctx context.Context, x *Ctx) (*Result, error) {
			return &Result{Data: map[string]any{"version": version.Version, "commit": version.CommitOrVCS(), "built": version.Date}, Text: version.String() + "\n"}, nil
		}},
		&Command{Name: "unlock", Summary: "Unlock the key of the running daemon (`elyon serve`) with the password.", Usage: "unlock", Access: Public, Run: unlockCmd,
			Params: []Param{{Name: "password", Secret: true}}},
		&Command{Name: "lock", Summary: "Lock the daemon now: the key is wiped from memory until `elyon unlock`.", Usage: "lock", Access: Public, Run: lockCmd},
		&Command{Name: "commands", Summary: "List every command with its HTTP path and parameters (for bots).", Usage: "commands", Access: Public, ReadOnly: true, Run: commandsCmd},
	)
}

func statusCmd(ctx context.Context, x *Ctx) (*Result, error) {
	data := map[string]any{"version": version.Version, "commit": version.CommitOrVCS(), "home": x.Home, "mode": x.Mode, "chain_id": config.ChainID}
	var b strings.Builder
	b.WriteString(version.String() + "\n\n")
	var warns []string
	start := time.Now()
	c, err := x.Chain(ctx)
	if err == nil {
		num, ts, herr := c.Head(ctx)
		if herr == nil {
			data["network"] = map[string]any{"ok": true, "rpc": x.Cfg.RPCURL, "block": num, "block_age_seconds": int(time.Since(ts).Seconds()), "latency_ms": time.Since(start).Milliseconds()}
			b.WriteString(line("Network", fmt.Sprintf("ElyonChain %d via %s — block %s (%ds ago)", config.ChainID, x.Cfg.RPCURL, amount.Group(fmt.Sprint(num)), int(time.Since(ts).Seconds()))))
		} else {
			err = herr
		}
	}
	if err != nil {
		data["network"] = map[string]any{"ok": false, "rpc": x.Cfg.RPCURL, "error": errs.As(err).Message}
		b.WriteString(line("Network", "UNREACHABLE: "+errs.As(err).Message))
	}
	if d, err := x.DEX().Health(ctx); err == nil {
		data["dex_api"] = map[string]any{"ok": true, "url": x.Cfg.APIURL, "latency_ms": d.Milliseconds()}
		b.WriteString(line("DEX API", fmt.Sprintf("%s — ok (%d ms)", x.Cfg.APIURL, d.Milliseconds())))
	} else {
		data["dex_api"] = map[string]any{"ok": false, "url": x.Cfg.APIURL, "error": errs.As(err).Message}
		b.WriteString(line("DEX API", x.Cfg.APIURL+" — UNREACHABLE"))
	}
	f, ferr := x.WalletFile()
	if ferr != nil {
		data["wallet"] = nil
		b.WriteString(line("Wallet", "none yet — run `elyon setup`"))
	} else {
		st := f.Meta.PasswordStatus(x.Now())
		w := map[string]any{"address": f.Address, "kind": f.Kind, "backup_confirmed": f.Meta.Backup.Confirmed, "password": st, "unlocked": x.Session.Unlocked(), "allowlist": len(f.Meta.Allowlist), "daily_limits": len(f.Meta.DailyLimits)}
		b.WriteString(line("Wallet", f.Address))
		if f.Meta.Backup.Confirmed {
			b.WriteString(line("Backup", "recovery secret confirmed ("+f.Meta.Backup.Method+")"))
		} else {
			b.WriteString(line("Backup", "NOT DONE — run `elyon wallet backup` in a terminal"))
			warns = append(warns, "The recovery phrase is not backed up yet.")
		}
		pw := fmt.Sprintf("valid until %s (%d days left, max age %d days)", st.ExpiresAt.Format("2006-01-02"), st.DaysLeft, st.MaxAgeDays)
		if st.Expired {
			pw = "EXPIRED — run `elyon password change`"
		}
		b.WriteString(line("Password", pw))
		if t := st.WarningText(); t != "" {
			warns = append(warns, t)
		}
		if x.Mode == ModeDaemon {
			lock := "locked"
			if x.Session.Unlocked() {
				lock = "unlocked (trading enabled)"
			}
			b.WriteString(line("Key", lock))
		}
		if c != nil {
			addr := f.AddressValue()
			if eln, err := c.NativeBalance(ctx, addr); err == nil {
				w["eln"] = amount.Format(eln, 18)
				usdt, _ := c.TokenBalance(ctx, config.Addr(x.Cfg.Contracts.WUSDT), addr)
				if usdt != nil {
					w["wusdt"] = amount.Format(usdt, 6)
				}
				b.WriteString(line("Balances", fmt.Sprintf("%s ELN (gas) · %s wUSDT", amount.FormatSig(eln, 18, 6), amount.FormatMax(usdt, 6, 6))))
				if eln.Cmp(big.NewInt(3_000_000_000_000_000)) < 0 {
					warns = append(warns, "Less than 0.003 ELN for network fees: send a little ELN or run `elyon gas buy 0.5`.")
				}
			}
		}
		data["wallet"] = w
	}
	b.WriteString(line("Home", x.Home))
	data["warnings"] = warns
	for _, w := range warns {
		x.Warn(w)
	}
	return &Result{Data: data, Text: b.String()}, nil
}

func portfolioCmd(ctx context.Context, x *Ctx) (*Result, error) {
	me, err := x.Address()
	if err != nil {
		return nil, err
	}
	type part struct {
		err error
	}
	// Balances.
	assets := x.knownAssets(ctx)
	pricesCh := make(chan map[common.Address]float64, 1)
	go func() { pricesCh <- x.priceMap(ctx) }()
	hs, err := x.balances(ctx, me, assets)
	if err != nil {
		return nil, err
	}
	prices := <-pricesCh
	wusdt := config.Addr(x.Cfg.Contracts.WUSDT)
	var shown []Holding
	walletValue := 0.0
	for _, h := range hs {
		h.ValueWUSDT = valueOf(h, prices, wusdt)
		if h.ValueWUSDT != nil {
			var f float64
			fmt.Sscan(*h.ValueWUSDT, &f)
			walletValue += f
		}
		if h.Raw != "0" || h.Kind == "native" || h.Kind == "wusdt" {
			shown = append(shown, h)
		}
	}
	sortHoldings(shown)
	data := map[string]any{"address": me.Hex(), "time": x.Now().UTC(), "balances": shown}
	var b strings.Builder
	fmt.Fprintf(&b, "Portfolio of %s — %s\n\nBALANCES\n", me.Hex(), x.Now().UTC().Format("2006-01-02 15:04:05 UTC"))
	for _, h := range shown {
		raw, _ := new(big.Int).SetString(h.Raw, 10)
		val := ""
		if h.ValueWUSDT != nil && h.Kind != "wusdt" {
			val = "≈ " + amount.Group(*h.ValueWUSDT) + " wUSDT"
		}
		fmt.Fprintf(&b, "  %-12s %22s   %s\n", h.Symbol, amount.Group(displayAmount(raw, h.Decimals)), val)
	}
	// Futures.
	margin, pnl, payout, reserved := 0.0, 0.0, 0.0, 0.0
	env, ferr := x.futures(ctx, false)
	if ferr == nil {
		ps, perr := x.positions(ctx, env, me, true)
		if perr == nil {
			x.enrich(ctx, env, ps)
			for _, p := range ps {
				margin += amount.ToFloat(p.MarginRaw, 6)
				if p.PnL != nil {
					var f float64
					fmt.Sscan(*p.PnL, &f)
					pnl += f
				}
				if p.PayoutNow != nil {
					var f float64
					fmt.Sscan(*p.PayoutNow, &f)
					payout += f
				}
			}
			data["positions"] = nonNil(ps)
			b.WriteString("\nOPEN POSITIONS\n")
			b.WriteString(indent(positionsText(ps)))
		} else {
			data["positions_error"] = errs.As(perr)
		}
		os, oerr := x.limitOrders(ctx, env, me, true)
		if oerr == nil {
			for _, o := range os {
				reserved += amount.ToFloat(o.MaxCostRaw, 6)
			}
			data["orders"] = nonNil(os)
			b.WriteString("\nOPEN LIMIT ORDERS\n")
			b.WriteString(indent(ordersText(os)))
		} else {
			data["orders_error"] = errs.As(oerr)
		}
	} else {
		data["futures_error"] = errs.As(ferr)
	}
	totals := map[string]string{
		"wallet_value_wusdt":          fmt.Sprintf("%.2f", walletValue),
		"margin_in_positions_wusdt":   fmt.Sprintf("%.6f", margin),
		"unrealized_pnl_wusdt":        fmt.Sprintf("%.6f", pnl),
		"payout_if_all_closed_wusdt":  fmt.Sprintf("%.6f", payout),
		"reserved_for_limit_orders":   fmt.Sprintf("%.6f", reserved),
		"total_equity_estimate_wusdt": fmt.Sprintf("%.2f", walletValue+payout),
	}
	data["totals"] = totals
	b.WriteString("\nTOTALS (estimates, ELN excluded)\n")
	b.WriteString(line("Wallet value", totals["wallet_value_wusdt"]+" wUSDT"))
	b.WriteString(line("Margin in use", totals["margin_in_positions_wusdt"]+" wUSDT"))
	b.WriteString(line("Unrealized PnL", totals["unrealized_pnl_wusdt"]+" wUSDT"))
	b.WriteString(line("Equity", totals["total_equity_estimate_wusdt"]+" wUSDT (wallet + positions if closed now)"))
	if reserved > 0 {
		b.WriteString(line("Limit orders", totals["reserved_for_limit_orders"]+" wUSDT must stay in the wallet for open orders"))
	}
	_ = part{}
	return &Result{Data: data, Text: b.String()}, nil
}

func indent(s string) string {
	var out []string
	for _, l := range strings.Split(strings.TrimRight(s, "\n"), "\n") {
		out = append(out, "  "+l)
	}
	return strings.Join(out, "\n") + "\n"
}

func txCmd(ctx context.Context, x *Ctx) (*Result, error) {
	h := x.P.Str("hash")
	if len(h) != 66 || !strings.HasPrefix(h, "0x") {
		return nil, errs.New(errs.InvalidInput, "Give a transaction hash (0x followed by 64 hexadecimal characters).")
	}
	hash := common.HexToHash(h)
	c, err := x.Chain(ctx)
	if err != nil {
		return nil, err
	}
	rec, err := c.Eth.TransactionReceipt(ctx, hash)
	if err != nil {
		if errors.Is(err, ethereum.NotFound) || strings.Contains(strings.ToLower(err.Error()), "pruned") {
			_, pending, terr := c.Eth.TransactionByHash(ctx, hash)
			if terr == nil && pending {
				return &Result{Data: map[string]any{"hash": h, "status": "pending"}, Text: "Pending: not mined yet.\n"}, nil
			}
			return &Result{Data: map[string]any{"hash": h, "status": "unknown"}, Text: "Unknown: the network does not know this transaction (not sent, dropped, or not seen yet).\n"}, nil
		}
		return nil, err
	}
	status := "confirmed"
	if rec.Status == 0 {
		status = "reverted"
	}
	fee := ""
	if rec.EffectiveGasPrice != nil {
		fee = amount.Format(new(big.Int).Mul(rec.EffectiveGasPrice, new(big.Int).SetUint64(rec.GasUsed)), 18)
	}
	text := fmt.Sprintf("Transaction %s: %s in block %d (gas %d, fee %s ELN)\n%s\n", h, strings.ToUpper(status), rec.BlockNumber.Uint64(), rec.GasUsed, fee, x.Explorer(h))
	return &Result{Data: map[string]any{"hash": h, "status": status, "block": rec.BlockNumber.Uint64(), "gas_used": rec.GasUsed, "fee_eln": fee, "explorer": x.Explorer(h)}, Text: text}, nil
}

func unlockCmd(ctx context.Context, x *Ctx) (*Result, error) {
	if x.Mode != ModeDaemon {
		return nil, errs.New(errs.InvalidInput, "No elyon daemon is running here. One-shot commands ask for the password themselves; start the daemon with `elyon serve`.")
	}
	pw, err := x.password("Wallet password")
	if err != nil {
		return nil, err
	}
	u, err := x.Unlock(pw)
	if err != nil {
		return nil, err
	}
	return &Result{Data: map[string]any{"unlocked": true, "address": u.Address.Hex()}, Text: "Unlocked: the daemon can trade again.\n"}, nil
}

func lockCmd(ctx context.Context, x *Ctx) (*Result, error) {
	if x.Mode != ModeDaemon {
		return nil, errs.New(errs.InvalidInput, "No elyon daemon is running here (one-shot commands never keep the key unlocked).")
	}
	x.Session.Lock()
	return &Result{Data: map[string]any{"locked": true}, Text: "Locked: the key was wiped from memory. Unlock again with `elyon unlock`.\n"}, nil
}

// CommandInfo describes a command for bots (GET /v1/commands).
type CommandInfo struct {
	Name     string   `json:"name"`
	ID       string   `json:"id"`
	Path     string   `json:"http_path,omitempty"`
	Methods  []string `json:"http_methods,omitempty"`
	Summary  string   `json:"summary"`
	Usage    string   `json:"cli_usage"`
	Params   []string `json:"params"`
	Access   string   `json:"needs"`
	HTTP     bool     `json:"available_over_http"`
	Examples []string `json:"examples,omitempty"`
}

// Describe returns the command catalogue.
func Describe() []CommandInfo {
	var out []CommandInfo
	for _, c := range Commands() {
		ci := CommandInfo{Name: c.Name, ID: c.ID(), Path: c.Path(), Summary: c.Summary, Usage: "elyon " + c.Usage, HTTP: !c.CLIOnly, Examples: c.Examples}
		ci.Methods = []string{"POST"}
		if c.ReadOnly {
			ci.Methods = []string{"GET", "POST"}
		}
		if c.CLIOnly {
			ci.Path, ci.Methods, ci.Access = "", nil, "a terminal (interactive)"
		}
		for _, p := range c.Params {
			ci.Params = append(ci.Params, p.Name)
		}
		ci.Access = map[Access]string{Public: "nothing", AddressOnly: "wallet address", KeyNeeded: "unlocked key"}[c.Access]
		out = append(out, ci)
	}
	out = append(out, CommandInfo{Name: "batch", ID: "batch", Path: "/v1/batch", Methods: []string{"POST"}, Summary: "Run several commands in order in one request (CLI: elyon run batch.json).", Usage: "elyon run <batch.json> [--continue-on-error]", Access: "depends on the steps", HTTP: true})
	return out
}

func commandsCmd(ctx context.Context, x *Ctx) (*Result, error) {
	d := Describe()
	var b strings.Builder
	for _, c := range d {
		fmt.Fprintf(&b, "%-22s %-28s %s\n", c.Name, c.Path, c.Summary)
	}
	return &Result{Data: map[string]any{"commands": d}, Text: b.String()}, nil
}

// ---------------------------------------------------------------- batch

// BatchStep is one command of a batch.
type BatchStep struct {
	Command string          `json:"command"`
	Params  json.RawMessage `json:"params"`
}

// Batch is the body of POST /v1/batch and the content of a batch file.
type Batch struct {
	StopOnError *bool       `json:"stop_on_error"`
	Commands    []BatchStep `json:"commands"`
}

// StepResult is the outcome of one step.
type StepResult struct {
	Index        int      `json:"index"`
	Command      string   `json:"command"`
	OK           bool     `json:"ok"`
	Skipped      bool     `json:"skipped,omitempty"`
	Result       any      `json:"result,omitempty"`
	Text         string   `json:"text,omitempty"`
	Error        *errs.E  `json:"error,omitempty"`
	Warnings     []string `json:"warnings,omitempty"`
	Transactions []TxView `json:"transactions,omitempty"`
}

// MaxBatchSteps bounds one batch.
const MaxBatchSteps = 50

// ParseBatch decodes and checks a batch document.
func ParseBatch(raw []byte) (*Batch, error) {
	var b Batch
	dec := json.NewDecoder(strings.NewReader(string(raw)))
	dec.DisallowUnknownFields()
	if err := dec.Decode(&b); err != nil {
		return nil, errs.Newf(errs.InvalidInput, "The batch is not valid JSON: %v. Expected {\"stop_on_error\": true, \"commands\": [{\"command\": \"futures price\", \"params\": {\"market\": \"BTC\"}}]}.", err)
	}
	if len(b.Commands) == 0 {
		return nil, errs.New(errs.InvalidInput, "The batch has no commands.")
	}
	if len(b.Commands) > MaxBatchSteps {
		return nil, errs.Newf(errs.InvalidInput, "A batch can have at most %d commands.", MaxBatchSteps)
	}
	return &b, nil
}

// ReadBatchFile reads a batch from a file ("-" = standard input).
func ReadBatchFile(path string) (*Batch, error) {
	var raw []byte
	var err error
	if path == "-" {
		raw, err = readAllStdin()
	} else {
		raw, err = os.ReadFile(path)
	}
	if err != nil {
		return nil, errs.Newf(errs.InvalidInput, "Cannot read the batch file: %v", err)
	}
	return ParseBatch(raw)
}

func readAllStdin() ([]byte, error) {
	var b strings.Builder
	buf := make([]byte, 32<<10)
	for {
		n, err := os.Stdin.Read(buf)
		b.Write(buf[:n])
		if err != nil {
			break
		}
		if b.Len() > 1<<20 {
			return nil, errors.New("batch larger than 1 MB")
		}
	}
	return []byte(b.String()), nil
}

// RunBatch executes the steps in order. With stop_on_error (default true) the remaining steps are skipped after
// the first failure.
func (a *App) RunBatch(ctx context.Context, b *Batch, req Request) ([]StepResult, bool) {
	stop := true
	if b.StopOnError != nil {
		stop = *b.StopOnError
	}
	var out []StepResult
	allOK, failed := true, false
	for i, step := range b.Commands {
		sr := StepResult{Index: i, Command: step.Command}
		cmd := Lookup(step.Command)
		if cmd != nil {
			sr.Command = cmd.ID()
		}
		if failed && stop {
			sr.Skipped = true
			sr.Error = errs.New("SKIPPED", "Skipped because an earlier step failed (stop_on_error).")
			out = append(out, sr)
			continue
		}
		var err error
		var res *Result
		switch {
		case cmd == nil:
			err = errs.Newf(errs.UnknownCommand, "Unknown command %q.", step.Command)
		case cmd.CLIOnly:
			err = errs.Newf(errs.NotAvailableHere, "`%s` is interactive and cannot run in a batch.", cmd.Name)
		default:
			sr.Command = cmd.ID()
			var p Params
			if p, err = ParamsFromJSON(step.Params); err == nil {
				res, err = a.Run(ctx, cmd, p, Request{Source: "batch", ClientIP: req.ClientIP, Password: req.Password})
			}
		}
		if res != nil {
			sr.Transactions = a.TxViews(res.Txs)
			sr.Warnings = res.Warnings
		}
		if err != nil {
			sr.Error = errs.As(err)
			allOK, failed = false, true
		} else {
			sr.OK, sr.Result, sr.Text = true, res.Data, res.Text
		}
		out = append(out, sr)
	}
	return out, allOK
}
