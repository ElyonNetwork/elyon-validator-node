package app

import (
	"context"
	"fmt"
	"math/big"
	"strings"
	"time"

	"github.com/ethereum/go-ethereum/common"

	"github.com/elyon-chain/elyon-bot/internal/amount"
	"github.com/elyon-chain/elyon-bot/internal/chain"
	"github.com/elyon-chain/elyon-bot/internal/config"
	"github.com/elyon-chain/elyon-bot/internal/errs"
	"github.com/elyon-chain/elyon-bot/internal/guard"
	"github.com/elyon-chain/elyon-bot/internal/keystore"
)

func init() {
	register(
		&Command{Name: "wallet address", Summary: "Show the wallet address (where you send wUSDT and ELN).", Usage: "wallet address", Access: AddressOnly, ReadOnly: true, Run: walletAddress,
			Examples: []string{"elyon wallet address"}},
		&Command{Name: "wallet balance", Summary: "Show ELN and every Elyon token you hold (non-zero by default).", Usage: "wallet balance [--all] [--token wBTC]", Access: AddressOnly, ReadOnly: true, Run: walletBalance,
			Params:   []Param{{Name: "all", Bool: true, Help: "list every token, also zero balances (about 1,400 lines)"}, {Name: "token", Help: "show only this token"}},
			Examples: []string{"elyon wallet balance", "elyon wallet balance --all", "elyon wallet balance --token wUSDT"}},
		&Command{Name: "wallet send", Summary: "Send ELN or a token from this wallet to another address (guarded).", Usage: "wallet send <amount|all> <TOKEN> to <address> [--allow-contract]", Access: KeyNeeded, Run: walletSend,
			Params:     []Param{{Name: "amount", Help: "amount, or all"}, {Name: "token", Help: "ELN, wUSDT, WELN, a ticker such as wBTC, or a token address"}, {Name: "to", Help: "destination address"}, {Name: "password", Secret: true, Help: "wallet password (needed unless the destination is on the approved list)"}, {Name: "allow_contract", Bool: true, Help: "allow a smart-contract destination"}},
			Positional: fill("amount", "token", "to"),
			Examples:   []string{"elyon wallet send 25 wUSDT to 0x0E0bB1BDEc7248eBac6eFBE624ceAEd86bda3e27", "elyon wallet send all ELN to 0x0E0bB1BDEc7248eBac6eFBE624ceAEd86bda3e27"}},
		&Command{Name: "wallet allow", Summary: "Approve a destination address for transfers without the password (asks for the password).", Usage: "wallet allow <address> [--label text]", Access: AddressOnly, Run: walletAllow,
			Params: []Param{{Name: "address", Help: "address to approve"}, {Name: "label", Help: "a name for it, e.g. \"my exchange\""}, {Name: "password", Secret: true, Help: "wallet password"}}, Positional: fill("address"),
			Examples: []string{"elyon wallet allow 0x0E0bB1BDEc7248eBac6eFBE624ceAEd86bda3e27 --label \"DEX wallet\""}},
		&Command{Name: "wallet disallow", Summary: "Remove an address from the approved list.", Usage: "wallet disallow <address>", Access: KeyNeeded, Run: walletDisallow,
			Params: []Param{{Name: "address", Help: "address to remove"}, {Name: "password", Secret: true, Help: "wallet password (CLI asks)"}}, Positional: fill("address")},
		&Command{Name: "wallet allowed", Summary: "List the approved transfer destinations.", Usage: "wallet allowed", Access: AddressOnly, ReadOnly: true, Run: walletAllowed},
		&Command{Name: "wallet limit", Summary: "Set (or remove with none) a daily transfer limit for a coin or token (asks for the password).", Usage: "wallet limit <amount|none> <TOKEN>", Access: AddressOnly, Run: walletLimit,
			Params: []Param{{Name: "amount", Help: "maximum per rolling 24 hours, or none"}, {Name: "token", Help: "ELN, wUSDT, …"}, {Name: "password", Secret: true, Help: "wallet password"}}, Positional: fill("amount", "token"),
			Examples: []string{"elyon wallet limit 500 wUSDT", "elyon wallet limit 1 ELN", "elyon wallet limit none wUSDT"}},
		&Command{Name: "wallet limits", Summary: "Show the daily transfer limits and what was sent in the last 24 hours.", Usage: "wallet limits", Access: AddressOnly, ReadOnly: true, Run: walletLimits},
		&Command{Name: "wallet create", Summary: "Create a new wallet: a fresh 24-word recovery phrase and address (terminal only).", Usage: "wallet create", CLIOnly: true},
		&Command{Name: "wallet restore", Summary: "Restore a wallet from its recovery phrase or a private key (terminal only).", Usage: "wallet restore [--private-key] [--from-stdin]", CLIOnly: true,
			Params: []Param{{Name: "private_key", Bool: true}, {Name: "from_stdin", Bool: true}}},
		&Command{Name: "wallet backup", Summary: "Show the recovery phrase once and confirm you wrote it down (terminal only).", Usage: "wallet backup [--show-again-i-understand-the-risk]", CLIOnly: true,
			Params: []Param{{Name: "show_again_i_understand_the_risk", Bool: true}}},
		&Command{Name: "password change", Summary: "Change the wallet password (asks for the old one; terminal only).", Usage: "password change", CLIOnly: true},
		&Command{Name: "password policy", Summary: "Set how many days a password stays valid (7–365, default 90; terminal only).", Usage: "password policy --max-age-days 90", CLIOnly: true,
			Params: []Param{{Name: "max_age_days"}}},
		&Command{Name: "setup", Summary: "Guided first run: create or restore the wallet, set the password, back up the phrase.", Usage: "setup", CLIOnly: true},
	)
}

func walletAddress(ctx context.Context, x *Ctx) (*Result, error) {
	addr, err := x.Address()
	if err != nil {
		return nil, err
	}
	verified := x.Session.Peek() != nil
	text := addr.Hex() + "\n"
	if x.Req.Source == "cli" {
		text = "Your wallet address on ElyonChain:\n\n  " + addr.Hex() + "\n\nSend wUSDT (for trading) and a little ELN (for network fees, 0.1 ELN is plenty) to this address.\n"
	}
	return &Result{Data: map[string]any{"address": addr.Hex(), "verified_with_key": verified, "explorer": x.Cfg.ExplorerURL + "/address/" + addr.Hex()}, Text: text}, nil
}

func walletBalance(ctx context.Context, x *Ctx) (*Result, error) {
	addr, err := x.Address()
	if err != nil {
		return nil, err
	}
	all, err := x.P.Bool("all")
	if err != nil {
		return nil, err
	}
	assets := x.knownAssets(ctx)
	if t := x.P.Str("token"); t != "" {
		as, err := x.resolveAsset(ctx, t)
		if err != nil {
			return nil, err
		}
		assets = []Asset{as}
		all = true
	}
	pricesCh := make(chan map[common.Address]float64, 1)
	go func() { pricesCh <- x.priceMap(ctx) }() // the market list can take a few seconds: fetch it meanwhile
	hs, err := x.balances(ctx, addr, assets)
	if err != nil {
		return nil, err
	}
	prices := <-pricesCh
	wusdt := config.Addr(x.Cfg.Contracts.WUSDT)
	var shown []Holding
	total := 0.0
	for _, h := range hs {
		h.ValueWUSDT = valueOf(h, prices, wusdt)
		if h.ValueWUSDT != nil {
			f, _ := new(big.Float).SetString(*h.ValueWUSDT)
			v, _ := f.Float64()
			total += v
		}
		if all || h.Raw != "0" || h.Kind == "native" || h.Kind == "wusdt" {
			shown = append(shown, h)
		}
	}
	sortHoldings(shown)
	var b strings.Builder
	fmt.Fprintf(&b, "Balances of %s\n\n", addr.Hex())
	for _, h := range shown {
		val := ""
		if h.ValueWUSDT != nil && h.Kind != "wusdt" {
			val = "≈ " + amount.Group(*h.ValueWUSDT) + " wUSDT"
		}
		raw, _ := new(big.Int).SetString(h.Raw, 10)
		fmt.Fprintf(&b, "  %-14s %24s   %s\n", h.Symbol, amount.Group(displayAmount(raw, h.Decimals)), val)
	}
	fmt.Fprintf(&b, "\n  Total value (tokens with a market price, ELN excluded) ≈ %s wUSDT\n", amount.Group(fmt.Sprintf("%.2f", total)))
	if !all {
		fmt.Fprintf(&b, "  %d tokens checked; zero balances hidden (use --all to list them).\n", len(assets))
	}
	return &Result{Data: map[string]any{"address": addr.Hex(), "tokens_checked": len(assets), "total_value_wusdt": fmt.Sprintf("%.2f", total), "balances": shown}, Text: b.String()}, nil
}

func walletSend(ctx context.Context, x *Ctx) (*Result, error) {
	c, err := x.Chain(ctx)
	if err != nil {
		return nil, err
	}
	from, err := x.Address()
	if err != nil {
		return nil, err
	}
	to, err := x.P.Address("to")
	if err != nil {
		return nil, err
	}
	if to == from {
		return nil, errs.New(errs.InvalidInput, "That is this wallet's own address.")
	}
	k := x.Cfg.Contracts
	for _, pinned := range []string{k.Router, k.Factory, k.PerpMarket, k.PerpTriggers, k.PerpLimitRouter, k.GasSale, k.WUSDT, k.WELN} {
		if to == config.Addr(pinned) {
			return nil, errs.Newf(errs.InvalidInput, "%s is an Elyon DEX contract, not a wallet: tokens sent there are lost.", to.Hex())
		}
	}
	as, err := x.resolveAsset(ctx, x.P.Str("token"))
	if err != nil {
		return nil, err
	}
	if !as.Native() && to == as.Address {
		return nil, errs.Newf(errs.InvalidInput, "%s is the %s token contract itself: tokens sent there are lost.", to.Hex(), as.Symbol)
	}
	allowContract, err := x.P.Bool("allow_contract")
	if err != nil {
		return nil, err
	}
	if isContract, err := c.HasCode(ctx, to); err != nil {
		return nil, err
	} else if isContract && !allowContract {
		return nil, errs.Newf(errs.InvalidInput, "%s is a smart contract, not a normal wallet. Funds sent to a contract that does not expect them are usually lost.", to.Hex()).WithHint("If you are sure, add --allow-contract.")
	}

	// Balance and amount.
	var bal *big.Int
	if as.Native() {
		bal, err = c.NativeBalance(ctx, from)
	} else {
		bal, err = c.TokenBalance(ctx, as.Address, from)
	}
	if err != nil {
		return nil, err
	}
	amt := x.P.Str("amount")
	var value *big.Int
	var gasLimit uint64
	fees, err := c.SuggestFees(ctx)
	if err != nil {
		return nil, err
	}
	switch {
	case strings.EqualFold(amt, "all") && as.Native():
		gasLimit = 21_000
		if allowContract {
			gasLimit = 100_000
		}
		reserve := new(big.Int).Mul(new(big.Int).SetUint64(gasLimit), fees.FeeCap)
		value = new(big.Int).Sub(bal, reserve)
		if value.Sign() <= 0 {
			return nil, errs.Newf(errs.NotEnoughGas, "The wallet holds %s ELN, not more than the network fee of the transfer.", amount.FormatSig(bal, 18, 6))
		}
	case strings.EqualFold(amt, "all"):
		value = bal
		if value.Sign() == 0 {
			return nil, errs.Newf(errs.InsufficientBalance, "The wallet holds no %s.", as.Symbol)
		}
	default:
		value, err = x.P.Amount("amount", as.Decimals)
		if err != nil {
			return nil, err
		}
		if value.Cmp(bal) > 0 {
			return nil, errs.Newf(errs.InsufficientBalance, "You hold %s %s but want to send %s %s.", amount.Format(bal, as.Decimals), as.Symbol, amount.Format(value, as.Decimals), as.Symbol).With("balance", amount.Format(bal, as.Decimals))
		}
	}

	// Protections: approved destination or password, and the daily limit (file re-checked against the key).
	u, err := x.Unlocked()
	if err != nil {
		return nil, err
	}
	if err := u.Reload(); err != nil {
		return nil, errs.As(x.mapUnlockErr(err))
	}
	if !x.pwVerified && !guard.Allowed(u.File.Meta.Allowlist, to) && x.P.Str("password") != "" {
		if _, err := x.RequirePassword("Wallet password"); err != nil {
			return nil, err
		}
	}
	x.Ledger.Merge()
	spent := x.Ledger.Spent(as.TokenKey(), x.Now())
	if err := guard.Authorize(guard.Request{To: to, Token: as.TokenKey(), Symbol: as.Symbol, Decimals: as.Decimals, Amount: value, PasswordOK: x.pwVerified}, u.File.Meta.Allowlist, u.File.Meta.DailyLimits, spent); err != nil {
		return nil, err
	}

	req := chain.TxRequest{Label: fmt.Sprintf("send %s %s", amount.Format(value, as.Decimals), as.Symbol), Revert: chain.RevertContext{"symbol": as.Symbol}}
	if as.Native() {
		req.To, req.Value = to, value
		if strings.EqualFold(amt, "all") {
			// Exact gas and fees so the whole balance minus the network fee can be sent.
			req.GasLimit, req.Fees = gasLimit, &fees
		}
	} else {
		req.To, req.Data = as.Address, chain.Pack(chain.ERC20ABI, "transfer", to, value)
	}
	res, err := x.Send(ctx, req)
	if err != nil {
		return nil, err
	}
	return sendResult(x, as, value, to, res), nil
}

func sendResult(x *Ctx, as Asset, value *big.Int, to common.Address, res *chain.TxResult) *Result {
	_ = x.Ledger.Record(guard.Entry{Time: x.Now().UTC(), Token: as.TokenKey(), Amount: value.String(), To: to.Hex(), Tx: res.Hash.Hex()})
	text := fmt.Sprintf("Sent %s %s to %s\n", amount.Group(amount.Format(value, as.Decimals)), as.Symbol, to.Hex()) + line("Transaction", res.Hash.Hex()) + line("Network fee", res.Fee+" ELN") + line("Explorer", x.Explorer(res.Hash.Hex()))
	return &Result{Data: map[string]any{"token": as.Symbol, "token_address": nilIfZero(as.Address), "amount": amount.Format(value, as.Decimals), "to": to.Hex(), "tx": res.Hash.Hex()}, Text: text}
}

func nilIfZero(a common.Address) any {
	if a == (common.Address{}) {
		return nil
	}
	return a.Hex()
}

func walletAllow(ctx context.Context, x *Ctx) (*Result, error) {
	addr, err := x.P.Address("address")
	if err != nil {
		return nil, err
	}
	pw, err := x.RequirePassword("Wallet password (needed to approve a destination)")
	if err != nil {
		return nil, err
	}
	u, done, err := x.unlockedForEdit(pw)
	if err != nil {
		return nil, err
	}
	defer done()
	label := x.P.Str("label")
	if len(label) > 60 {
		label = label[:60]
	}
	for _, e := range u.File.Meta.Allowlist {
		if common.HexToAddress(e.Address) == addr {
			return &Result{Data: map[string]any{"address": addr.Hex(), "already": true}, Text: addr.Hex() + " is already approved.\n"}, nil
		}
	}
	u.File.Meta.Allowlist = append(u.File.Meta.Allowlist, keystore.AllowEntry{Address: addr.Hex(), Label: label, AddedAt: x.Now().UTC().Truncate(time.Second)})
	if err := u.SaveMeta(); err != nil {
		return nil, err
	}
	return &Result{Data: map[string]any{"address": addr.Hex(), "label": label}, Text: fmt.Sprintf("Approved %s%s. Transfers to it no longer need the password (daily limits still apply).\n", addr.Hex(), labelSuffix(label))}, nil
}

func labelSuffix(l string) string {
	if l == "" {
		return ""
	}
	return " (" + l + ")"
}

// unlockedForEdit returns an unlocked wallet whose settings may be changed: the session's (re-read from disk and
// verified) or a temporary one unlocked with pw. done() wipes a temporary one.
func (x *Ctx) unlockedForEdit(pw []byte) (*keystore.Unlocked, func(), error) {
	if u := x.Session.Peek(); u != nil {
		if err := u.Reload(); err != nil {
			return nil, nil, x.mapUnlockErr(err)
		}
		return u, func() {}, nil
	}
	f, err := x.WalletFile()
	if err != nil {
		return nil, nil, err
	}
	u, err := f.Unlock(pw, x.Now(), keystore.UnlockOptions{})
	if err != nil {
		return nil, nil, x.mapUnlockErr(err)
	}
	return u, u.Wipe, nil
}

func walletDisallow(ctx context.Context, x *Ctx) (*Result, error) {
	addr, err := x.P.Address("address")
	if err != nil {
		return nil, err
	}
	u, err := x.Unlocked()
	if err != nil {
		return nil, err
	}
	if err := u.Reload(); err != nil {
		return nil, x.mapUnlockErr(err)
	}
	keep := u.File.Meta.Allowlist[:0]
	removed := false
	for _, e := range u.File.Meta.Allowlist {
		if common.HexToAddress(e.Address) == addr {
			removed = true
			continue
		}
		keep = append(keep, e)
	}
	if !removed {
		return nil, errs.Newf(errs.NotFound, "%s is not on the approved list.", addr.Hex())
	}
	u.File.Meta.Allowlist = keep
	if err := u.SaveMeta(); err != nil {
		return nil, err
	}
	return &Result{Data: map[string]any{"address": addr.Hex(), "removed": true}, Text: "Removed " + addr.Hex() + " from the approved list.\n"}, nil
}

func walletAllowed(ctx context.Context, x *Ctx) (*Result, error) {
	f, err := x.WalletFile()
	if err != nil {
		return nil, err
	}
	var b strings.Builder
	if len(f.Meta.Allowlist) == 0 {
		b.WriteString("No approved destinations. Every transfer needs the wallet password.\nApprove one with `elyon wallet allow <address>`.\n")
	} else {
		b.WriteString("Approved transfer destinations (no password needed; daily limits still apply):\n\n")
		for _, e := range f.Meta.Allowlist {
			fmt.Fprintf(&b, "  %s  %-24s added %s\n", e.Address, e.Label, e.AddedAt.Format("2006-01-02"))
		}
	}
	return &Result{Data: map[string]any{"allowlist": f.Meta.Allowlist}, Text: b.String()}, nil
}

func walletLimit(ctx context.Context, x *Ctx) (*Result, error) {
	as, err := x.resolveAsset(ctx, x.P.Str("token"))
	if err != nil {
		return nil, err
	}
	amt := x.P.Str("amount")
	var value *big.Int
	if !strings.EqualFold(amt, "none") && !strings.EqualFold(amt, "off") {
		if value, err = x.P.Amount("amount", as.Decimals); err != nil {
			return nil, err
		}
	}
	pw, err := x.RequirePassword("Wallet password (needed to change a limit)")
	if err != nil {
		return nil, err
	}
	u, done, err := x.unlockedForEdit(pw)
	if err != nil {
		return nil, err
	}
	defer done()
	var keep []keystore.DailyLimit
	for _, l := range u.File.Meta.DailyLimits {
		if !strings.EqualFold(l.Token, as.TokenKey()) {
			keep = append(keep, l)
		}
	}
	text := fmt.Sprintf("Removed the daily limit for %s.\n", as.Symbol)
	if value != nil {
		keep = append(keep, keystore.DailyLimit{Token: as.TokenKey(), Symbol: as.Symbol, Decimals: as.Decimals, Amount: value.String()})
		text = fmt.Sprintf("Daily limit set: at most %s %s per rolling 24 hours.\n", amount.Format(value, as.Decimals), as.Symbol)
	}
	if keep == nil {
		keep = []keystore.DailyLimit{}
	}
	u.File.Meta.DailyLimits = keep
	if err := u.SaveMeta(); err != nil {
		return nil, err
	}
	return &Result{Data: map[string]any{"token": as.Symbol, "limit": optAmount(value, as.Decimals)}, Text: text}, nil
}

func optAmount(v *big.Int, d int) any {
	if v == nil {
		return nil
	}
	return amount.Format(v, d)
}

func walletLimits(ctx context.Context, x *Ctx) (*Result, error) {
	f, err := x.WalletFile()
	if err != nil {
		return nil, err
	}
	x.Ledger.Merge()
	type row struct {
		Token  string `json:"token"`
		Limit  string `json:"limit_per_24h"`
		Sent   string `json:"sent_last_24h"`
		Remain string `json:"remaining"`
	}
	var rows []row
	var b strings.Builder
	if len(f.Meta.DailyLimits) == 0 {
		b.WriteString("No daily transfer limits are set. Set one with `elyon wallet limit 500 wUSDT`.\n")
	}
	for _, l := range f.Meta.DailyLimits {
		max, _ := new(big.Int).SetString(l.Amount, 10)
		spent := x.Ledger.Spent(l.Token, x.Now())
		left := new(big.Int).Sub(max, spent)
		if left.Sign() < 0 {
			left.SetInt64(0)
		}
		r := row{l.Symbol, amount.Format(max, l.Decimals), amount.Format(spent, l.Decimals), amount.Format(left, l.Decimals)}
		rows = append(rows, r)
		fmt.Fprintf(&b, "  %-8s limit %s per 24 h · sent %s · remaining %s\n", r.Token, r.Limit, r.Sent, r.Remain)
	}
	return &Result{Data: map[string]any{"limits": rows}, Text: b.String()}, nil
}
