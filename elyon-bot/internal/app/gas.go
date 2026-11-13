package app

import (
	"context"
	"fmt"
	"math/big"
	"strings"

	"github.com/ethereum/go-ethereum/common"

	"github.com/elyon-chain/elyon-bot/internal/amount"
	"github.com/elyon-chain/elyon-bot/internal/chain"
	"github.com/elyon-chain/elyon-bot/internal/config"
	"github.com/elyon-chain/elyon-bot/internal/errs"
)

func init() {
	register(
		&Command{Name: "gas price", Summary: "Show the fixed price and limits of buying ELN for gas with wUSDT.", Usage: "gas price", Access: Public, ReadOnly: true, Run: gasPriceCmd},
		&Command{Name: "gas buy", Summary: "Buy ELN for network fees at the fixed price, paid in wUSDT (the website's \"Buy ELN for gas\").", Usage: "gas buy <ELN amount>", Access: KeyNeeded, Run: gasBuyCmd,
			Params: []Param{{Name: "amount", Help: "ELN to buy (per purchase and per day limits apply)"}}, Positional: fill("amount"), Examples: []string{"elyon gas buy 1"}},
		&Command{Name: "wrap", Summary: "Wrap ELN into WELN (1:1, no fee besides gas).", Usage: "wrap <amount|all>", Access: KeyNeeded, Run: wrapCmd,
			Params: []Param{{Name: "amount"}}, Positional: wrapPositional, Examples: []string{"elyon wrap 0.5"}},
		&Command{Name: "unwrap", Summary: "Unwrap WELN back into ELN (1:1).", Usage: "unwrap <amount|all>", Access: KeyNeeded, Run: unwrapCmd,
			Params: []Param{{Name: "amount"}}, Positional: wrapPositional, Examples: []string{"elyon unwrap all"}},
	)
}

func wrapPositional(args []string, p Params) error {
	var words []string
	for _, a := range args {
		if u := strings.ToUpper(a); u != "ELN" && u != "WELN" {
			words = append(words, a)
		}
	}
	return fill("amount")(words, p)
}

type saleState struct {
	Price, Min, Max, Daily, Bought, Remaining, Inventory *big.Int
	Paused                                               bool
	Treasury, QuoteToken                                 common.Address
}

func (x *Ctx) gasSale(ctx context.Context, buyer common.Address) (*saleState, error) {
	c, err := x.Chain(ctx)
	if err != nil {
		return nil, err
	}
	sale := config.Addr(x.Cfg.Contracts.GasSale)
	v, err := c.Read(ctx, chain.GasSaleABI, sale, "saleState", buyer)
	if err != nil {
		return nil, errs.New(errs.GasSaleUnavailable, "Buying ELN for gas is temporarily unavailable. Please try again in a moment.").Wrap(err)
	}
	s := &saleState{Price: v[0].(*big.Int), Min: v[1].(*big.Int), Max: v[2].(*big.Int), Daily: v[3].(*big.Int), Bought: v[4].(*big.Int), Remaining: v[5].(*big.Int), Inventory: v[6].(*big.Int), Paused: v[7].(bool), Treasury: v[8].(common.Address), QuoteToken: v[9].(common.Address)}
	// Same safety check as the website: the sale must pay the expected treasury in wUSDT.
	if s.Treasury != config.Addr(x.Cfg.Contracts.GasSaleTreasury) || s.QuoteToken != config.Addr(x.Cfg.Contracts.WUSDT) {
		return nil, errs.Newf(errs.ContractMismatch, "The gas sale contract now pays %s in %s, which this elyon-bot does not expect. Refusing to use it.", s.Treasury.Hex(), s.QuoteToken.Hex()).WithHint("Update elyon-bot.")
	}
	return s, nil
}

func gasPriceCmd(ctx context.Context, x *Ctx) (*Result, error) {
	buyer := common.Address{}
	if a, err := x.Address(); err == nil {
		buyer = a
	}
	s, err := x.gasSale(ctx, buyer)
	if err != nil {
		return nil, err
	}
	var b strings.Builder
	b.WriteString("Buy ELN for gas (fixed price, paid in wUSDT)\n")
	b.WriteString(line("Price", amount.Format(s.Price, 6)+" wUSDT per ELN"))
	b.WriteString(line("Per purchase", amount.Format(s.Min, 18)+" to "+amount.Format(s.Max, 18)+" ELN"))
	b.WriteString(line("Per wallet per day", amount.Format(s.Daily, 18)+" ELN (resets 00:00 UTC)"))
	if buyer != (common.Address{}) {
		b.WriteString(line("Left today", amount.Format(s.Remaining, 18)+" ELN"))
	}
	b.WriteString(line("Available", amount.FormatMax(s.Inventory, 18, 2)+" ELN"))
	state := "open"
	if s.Paused {
		state = "paused"
	}
	b.WriteString(line("Status", state))
	b.WriteString("  ELN bought here is for network fees only. It cannot be sold on ElyonDex.\n")
	return &Result{Data: map[string]any{"price_wusdt": amount.Format(s.Price, 6), "min_eln": amount.Format(s.Min, 18), "max_eln": amount.Format(s.Max, 18), "daily_max_eln": amount.Format(s.Daily, 18),
		"remaining_today_eln": amount.Format(s.Remaining, 18), "inventory_eln": amount.Format(s.Inventory, 18), "paused": s.Paused}, Text: b.String()}, nil
}

func gasBuyCmd(ctx context.Context, x *Ctx) (*Result, error) {
	want, err := x.P.Amount("amount", 18)
	if err != nil {
		return nil, err
	}
	me, err := x.Address()
	if err != nil {
		return nil, err
	}
	s, err := x.gasSale(ctx, me)
	if err != nil {
		return nil, err
	}
	switch {
	case s.Paused:
		return nil, errs.New(errs.GasSaleUnavailable, "Buying ELN for gas is paused right now. Please try again later.")
	case want.Cmp(s.Min) < 0 || want.Cmp(s.Max) > 0:
		return nil, errs.Newf(errs.InvalidInput, "Choose between %s and %s ELN per purchase.", amount.Format(s.Min, 18), amount.Format(s.Max, 18))
	case s.Remaining.Sign() == 0:
		return nil, errs.New(errs.DailyLimit, "This wallet has reached its daily limit. It resets at 00:00 UTC.")
	case want.Cmp(s.Remaining) > 0:
		return nil, errs.Newf(errs.DailyLimit, "This wallet can buy up to %s more ELN today.", amount.Format(s.Remaining, 18))
	case want.Cmp(s.Inventory) > 0:
		return nil, errs.New(errs.GasSaleUnavailable, "Not enough ELN is available right now. Try a smaller amount or come back later.")
	}
	c, err := x.Chain(ctx)
	if err != nil {
		return nil, err
	}
	sale := config.Addr(x.Cfg.Contracts.GasSale)
	q, err := c.Read(ctx, chain.GasSaleABI, sale, "quote", want)
	if err != nil {
		return nil, err
	}
	cost := q[0].(*big.Int)
	wusdt := config.Addr(x.Cfg.Contracts.WUSDT)
	bal, err := c.TokenBalance(ctx, wusdt, me)
	if err != nil {
		return nil, err
	}
	if bal.Cmp(cost) < 0 {
		return nil, errs.Newf(errs.InsufficientBalance, "This purchase costs %s wUSDT and your wallet holds %s wUSDT.", amount.Format(cost, 6), amount.Format(bal, 6))
	}
	if err := x.EnsureAllowance(ctx, wusdt, sale, cost, "wUSDT", false); err != nil {
		return nil, err
	}
	tx, err := x.Send(ctx, chain.TxRequest{To: sale, Data: chain.Pack(chain.GasSaleABI, "buy", want, cost), Label: "buy " + amount.Format(want, 18) + " ELN for gas", Revert: chain.RevertContext{"symbol": "wUSDT"}})
	if err != nil {
		return nil, err
	}
	text := fmt.Sprintf("You received %s ELN for %s wUSDT.\n", amount.Format(want, 18), amount.Format(cost, 6)) + line("Transaction", tx.Hash.Hex())
	return &Result{Data: map[string]any{"eln": amount.Format(want, 18), "cost_wusdt": amount.Format(cost, 6), "tx": tx.Hash.Hex()}, Text: text}, nil
}

func wrapCmd(ctx context.Context, x *Ctx) (*Result, error) {
	c, err := x.Chain(ctx)
	if err != nil {
		return nil, err
	}
	me, err := x.Address()
	if err != nil {
		return nil, err
	}
	bal, err := c.NativeBalance(ctx, me)
	if err != nil {
		return nil, err
	}
	var v *big.Int
	if strings.EqualFold(x.P.Str("amount"), "all") {
		// Keep ELN back for the network fee (like the website's MAX: gas × 1.2), plus 0.01 ELN for later trades.
		fees, err := c.SuggestFees(ctx)
		if err != nil {
			return nil, err
		}
		reserve := new(big.Int).Mul(big.NewInt(80_000), fees.FeeCap)
		reserve.Add(reserve, big.NewInt(10_000_000_000_000_000))
		v = new(big.Int).Sub(bal, reserve)
		if v.Sign() <= 0 {
			return nil, errs.New(errs.NotEnoughGas, "The ELN balance is too small to wrap after keeping some for network fees.")
		}
	} else if v, err = x.P.Amount("amount", 18); err != nil {
		return nil, err
	}
	if v.Cmp(bal) >= 0 {
		return nil, errs.Newf(errs.InsufficientBalance, "Insufficient ELN: the wallet holds %s ELN and also needs a little for the network fee.", amount.Format(bal, 18))
	}
	weln := config.Addr(x.Cfg.Contracts.WELN)
	tx, err := x.Send(ctx, chain.TxRequest{To: weln, Data: chain.Pack(chain.WETHABI, "deposit"), Value: v, Label: "wrap " + amount.Format(v, 18) + " ELN"})
	if err != nil {
		return nil, err
	}
	return &Result{Data: map[string]any{"wrapped_eln": amount.Format(v, 18), "tx": tx.Hash.Hex()}, Text: fmt.Sprintf("Wrapped %s ELN into WELN.\n", amount.Format(v, 18)) + line("Transaction", tx.Hash.Hex())}, nil
}

func unwrapCmd(ctx context.Context, x *Ctx) (*Result, error) {
	c, err := x.Chain(ctx)
	if err != nil {
		return nil, err
	}
	me, err := x.Address()
	if err != nil {
		return nil, err
	}
	weln := config.Addr(x.Cfg.Contracts.WELN)
	bal, err := c.TokenBalance(ctx, weln, me)
	if err != nil {
		return nil, err
	}
	var v *big.Int
	if strings.EqualFold(x.P.Str("amount"), "all") {
		v = bal
	} else if v, err = x.P.Amount("amount", 18); err != nil {
		return nil, err
	}
	if v.Sign() == 0 || v.Cmp(bal) > 0 {
		return nil, errs.Newf(errs.InsufficientBalance, "Insufficient WELN: the wallet holds %s WELN.", amount.Format(bal, 18))
	}
	tx, err := x.Send(ctx, chain.TxRequest{To: weln, Data: chain.Pack(chain.WETHABI, "withdraw", v), Label: "unwrap " + amount.Format(v, 18) + " WELN"})
	if err != nil {
		return nil, err
	}
	return &Result{Data: map[string]any{"unwrapped_weln": amount.Format(v, 18), "tx": tx.Hash.Hex()}, Text: fmt.Sprintf("Unwrapped %s WELN into ELN.\n", amount.Format(v, 18)) + line("Transaction", tx.Hash.Hex())}, nil
}
