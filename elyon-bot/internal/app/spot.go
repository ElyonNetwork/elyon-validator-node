package app

import (
	"context"
	"fmt"
	"math/big"
	"strconv"
	"strings"
	"time"

	"github.com/ethereum/go-ethereum/common"
	"github.com/ethereum/go-ethereum/core/types"

	"github.com/elyon-chain/elyon-bot/internal/amount"
	"github.com/elyon-chain/elyon-bot/internal/chain"
	"github.com/elyon-chain/elyon-bot/internal/config"
	"github.com/elyon-chain/elyon-bot/internal/errs"
	"github.com/elyon-chain/elyon-bot/internal/registry"
	"github.com/elyon-chain/elyon-bot/internal/spot"
)

// Website rules of the market-page swap (apps/web/src/components/markets/MarketSwap.tsx).
const (
	spotDeadline     = 120 * time.Second // order deadline
	spotFeedMaxAge   = 30 * time.Second  // the reference feed must be this fresh
	spotDefaultWait  = 45                // seconds to wait for the pool to come in line with the global price
	spotGasFallback  = 400_000
	spotGasMulNum    = 3
	spotGasMulDen    = 2
	spotGasAdd       = 20_000
	spotMaxSlipBps   = 500
	spotSyncTolBps   = spot.SyncToleranceBps
	maxSpotListLimit = 2000
)

var spotTradeParams = []Param{
	{Name: "slippage", Help: "maximum slippage in percent (default 0.5, like the website; max 5)"},
	{Name: "max_wait", Help: "seconds to wait for the pool to match the global price (default 45, like the website)"},
}

func init() {
	register(
		&Command{Name: "spot markets", Summary: "List spot markets (wrapped tokens traded against wUSDT).", Usage: "spot markets [--search BTC] [--limit 50]", Access: Public, ReadOnly: true, Run: spotMarketsCmd,
			Params: []Param{{Name: "search", Help: "filter by ticker or name"}, {Name: "limit", Help: "how many rows (default 50; 0 = all)"}}, Positional: fill("search"),
			Examples: []string{"elyon spot markets", "elyon spot markets --search doge"}},
		&Command{Name: "spot price", Summary: "Show the pool price and the global reference price of a spot market.", Usage: "spot price <MARKET>", Access: Public, ReadOnly: true, Run: spotPriceCmd,
			Params: []Param{{Name: "market", Help: "BTC, wBTC, ETH…"}}, Positional: fill("market"), Examples: []string{"elyon spot price BTC"}},
		&Command{Name: "spot quote", Summary: "Preview a buy, sell or swap without trading.", Usage: "spot quote buy BTC --spend 100 | buy 0.01 BTC | sell 0.01 BTC | swap 5 wBTC to wETH", Access: Public, ReadOnly: true, Run: spotQuoteCmd,
			Params:     append([]Param{{Name: "side", Help: "buy, sell or swap"}, {Name: "market"}, {Name: "spend", Help: "wUSDT to spend (buy)"}, {Name: "amount", Help: "amount of the token (buy exact / sell / swap)"}, {Name: "from"}, {Name: "to"}}, spotTradeParams...),
			Positional: quotePositional, Examples: []string{"elyon spot quote buy BTC --spend 100", "elyon spot quote sell 0.01 BTC", "elyon spot quote swap 0.01 wBTC to wETH"}},
		&Command{Name: "spot buy", Summary: "Buy a token with wUSDT: spend an amount of wUSDT, or buy an exact amount of the token.", Usage: "spot buy <MARKET> --spend <wUSDT>   |   spot buy <amount> <MARKET>", Access: KeyNeeded, Run: spotBuyCmd,
			Params: append([]Param{{Name: "market"}, {Name: "spend", Help: "wUSDT to spend"}, {Name: "amount", Help: "exact amount of the token to receive"}}, spotTradeParams...), Positional: buyPositional,
			Examples: []string{"elyon spot buy BTC --spend 100", "elyon spot buy 0.01 BTC"}},
		&Command{Name: "spot sell", Summary: "Sell a token for wUSDT.", Usage: "spot sell <amount|all> <MARKET>", Access: KeyNeeded, Run: spotSellCmd,
			Params: append([]Param{{Name: "amount", Help: "amount to sell, or all"}, {Name: "market"}}, spotTradeParams...), Positional: fill("amount", "market"),
			Examples: []string{"elyon spot sell 0.01 BTC", "elyon spot sell all BTC"}},
		&Command{Name: "spot swap", Summary: "Swap one token for another (through wUSDT when neither side is wUSDT).", Usage: "spot swap <amount|all> <TOKEN> to <TOKEN>", Access: KeyNeeded, Run: spotSwapCmd,
			Params: append([]Param{{Name: "amount", Help: "amount of the token you give, or all"}, {Name: "from", Help: "token you give"}, {Name: "to", Help: "token you get"}}, spotTradeParams...), Positional: fill("amount", "from", "to"),
			Examples: []string{"elyon spot swap 5 wUSDT to wBTC", "elyon spot swap 0.001 wBTC to wETH"}},
	)
}

func buyPositional(args []string, p Params) error {
	// "buy BTC" or "buy 0.01 BTC"
	switch len(args) {
	case 1:
		p["market"] = args[0]
	case 2:
		p["amount"], p["market"] = args[0], args[1]
	case 0:
	default:
		return fmt.Errorf("too many words")
	}
	return nil
}

func quotePositional(args []string, p Params) error {
	if len(args) == 0 {
		return nil
	}
	p["side"] = strings.ToLower(args[0])
	rest := args[1:]
	switch p["side"] {
	case "buy":
		return buyPositional(rest, p)
	case "sell":
		return fill("amount", "market")(rest, p)
	case "swap":
		return fill("amount", "from", "to")(rest, p)
	}
	return fmt.Errorf("start with buy, sell or swap")
}

// spotMarkets returns the DEX's spot markets, cross-checked against the built-in token list (a market whose token
// differs from the built-in list is dropped) and without the ELN market.
func (x *Ctx) spotMarkets(ctx context.Context) ([]spot.Market, error) {
	sm, err := x.DEX().SpotMarkets(ctx)
	if err != nil {
		return nil, err
	}
	out := make([]spot.Market, 0, len(sm.Markets))
	for _, r := range sm.Markets {
		if spot.IsELN(r.Symbol) || !common.IsHexAddress(r.Token) || !common.IsHexAddress(r.Pool) {
			continue
		}
		tok := common.HexToAddress(r.Token)
		verdict := registry.Check(r.Symbol, tok)
		if verdict == registry.Mismatch {
			continue
		}
		dec := 18
		if t, ok := registry.ByBase(r.Symbol); ok {
			dec = t.Decimals
		}
		at := ""
		if r.At != nil {
			at = *r.At
		}
		out = append(out, spot.Market{Base: r.Symbol, Display: r.Display, Name: r.Name, Token: tok, Pool: common.HexToAddress(r.Pool), Decimals: dec, Tier: r.Tier, New: verdict == registry.New,
			Price: r.Price, Reference: r.ReferencePrc, Change24h: r.Change24hPct, Volume24h: r.Volume24h, Liquidity: r.LiquidityUsdt, FeedOK: r.FeedOK, At: at})
	}
	return out, nil
}

func (x *Ctx) spotMarket(ctx context.Context, name string) (*spot.Market, error) {
	ms, err := x.spotMarkets(ctx)
	if err != nil {
		return nil, err
	}
	return spot.Resolve(name, ms)
}

func spotMarketsCmd(ctx context.Context, x *Ctx) (*Result, error) {
	ms, err := x.spotMarkets(ctx)
	if err != nil {
		return nil, err
	}
	ms = spot.Search(ms, x.P.Str("search"))
	total := len(ms)
	limit, err := x.P.Int("limit", 50)
	if err != nil {
		return nil, err
	}
	if limit > 0 && int(limit) < len(ms) {
		ms = ms[:limit]
	}
	var b strings.Builder
	fmt.Fprintf(&b, "%-10s %-28s %16s %9s %16s\n", "MARKET", "NAME", "PRICE (wUSDT)", "24H", "VOLUME 24H")
	for _, m := range ms {
		price, ch := "—", "—"
		if m.Price != nil {
			price = amount.Price(*m.Price)
		}
		if m.Change24h != nil {
			ch = fmt.Sprintf("%+.2f%%", *m.Change24h)
		}
		name := m.Name
		if len(name) > 28 {
			name = name[:27] + "…"
		}
		fmt.Fprintf(&b, "%-10s %-28s %16s %9s %16s\n", m.Display, name, price, ch, amount.Group(fmt.Sprintf("%.0f", m.Volume24h)))
	}
	fmt.Fprintf(&b, "\n%d of %d markets shown. ELN is not traded on ElyonDex until its exchange listing.\n", len(ms), total)
	return &Result{Data: map[string]any{"count": total, "shown": len(ms), "markets": ms}, Text: b.String()}, nil
}

// poolState is a fresh view of one pool: on-chain reserves and the DEX reference price.
type poolState struct {
	M            *spot.Market
	ReserveBase  *big.Int
	ReserveQuote *big.Int
	Mid          float64
	Reference    float64
	FeedOK       bool
	FeedAge      time.Duration
	InSync       bool
}

func (x *Ctx) readPool(ctx context.Context, m *spot.Market) (*poolState, error) {
	k := x.Cfg.Contracts
	wusdt := config.Addr(k.WUSDT)
	if want := spot.PairFor(config.Addr(k.Factory), m.Token, wusdt); want != m.Pool {
		return nil, errs.Newf(errs.ContractMismatch, "The DEX names pool %s for %s but the canonical pool is %s; refusing to trade.", m.Pool.Hex(), m.Display, want.Hex())
	}
	c, err := x.Chain(ctx)
	if err != nil {
		return nil, err
	}
	res := c.BatchCall(ctx, []chain.Call{{To: m.Pool, Data: chain.Pack(chain.PairABI, "getReserves")}, {To: m.Pool, Data: chain.Pack(chain.PairABI, "token0")}})
	if res[0].Err != nil || res[1].Err != nil {
		return nil, errs.Newf(errs.RPCUnavailable, "Could not read the %s pool.", m.Display)
	}
	r, err := chain.PairABI.Unpack("getReserves", res[0].Data)
	if err != nil {
		return nil, errs.Newf(errs.RPCUnavailable, "Could not read the %s pool.", m.Display)
	}
	t0 := common.BytesToAddress(res[1].Data)
	r0, r1 := r[0].(*big.Int), r[1].(*big.Int)
	st := &poolState{M: m}
	if t0 == m.Token {
		st.ReserveBase, st.ReserveQuote = r0, r1
	} else {
		st.ReserveBase, st.ReserveQuote = r1, r0
	}
	st.Mid = spot.MidPrice(st.ReserveBase, st.ReserveQuote, m.Decimals, 6)
	detail, serverTime, err := x.DEX().SpotMarketDetail(ctx, m.Base)
	if err == nil {
		if detail.ReferencePrc != nil {
			st.Reference = *detail.ReferencePrc
		}
		st.FeedOK = detail.FeedOK
		if detail.At != nil {
			if t, err := time.Parse(time.RFC3339Nano, *detail.At); err == nil {
				st.FeedAge = serverTime.Sub(t)
			}
		}
	}
	st.InSync = st.FeedOK && st.FeedAge < spotFeedMaxAge && spot.InSync(st.Mid, st.Reference, spotSyncTolBps)
	return st, nil
}

func spotPriceCmd(ctx context.Context, x *Ctx) (*Result, error) {
	m, err := x.spotMarket(ctx, x.P.Str("market"))
	if err != nil {
		return nil, err
	}
	st, err := x.readPool(ctx, m)
	if err != nil {
		return nil, err
	}
	diff := 0.0
	if st.Reference > 0 {
		diff = (st.Mid/st.Reference - 1) * 10_000
	}
	var b strings.Builder
	fmt.Fprintf(&b, "%s / wUSDT\n", m.Label())
	b.WriteString(line("Pool price", amount.Price(st.Mid)+" wUSDT"))
	b.WriteString(line("Global price", amount.Price(st.Reference)+" wUSDT"))
	b.WriteString(line("Difference", fmt.Sprintf("%+.1f bps (%s)", diff, map[bool]string{true: "in line, ready to trade", false: "the market makers are catching up"}[st.InSync])))
	if m.Change24h != nil {
		b.WriteString(line("24h change", fmt.Sprintf("%+.2f%%", *m.Change24h)))
	}
	b.WriteString(line("24h volume", amount.Group(fmt.Sprintf("%.0f", m.Volume24h))+" wUSDT"))
	b.WriteString(line("Pool reserves", amount.Group(amount.FormatSig(st.ReserveBase, m.Decimals, 8))+" "+m.Display+" / "+amount.Group(amount.FormatMax(st.ReserveQuote, 6, 2))+" wUSDT"))
	b.WriteString(line("Pool fee", "0.30 % per trade"))
	return &Result{Data: map[string]any{"market": m, "pool_price": st.Mid, "reference_price": st.Reference, "difference_bps": diff, "in_sync": st.InSync,
		"reserve_base": amount.Format(st.ReserveBase, m.Decimals), "reserve_wusdt": amount.Format(st.ReserveQuote, 6), "pool_fee_pct": 0.3}, Text: b.String()}, nil
}

// spotOrder is a prepared trade.
type spotOrder struct {
	ExactOut    bool
	InToken     common.Address
	InSymbol    string
	InDecimals  int
	OutToken    common.Address
	OutSymbol   string
	OutDecimals int
	Path        []common.Address
	Markets     []*spot.Market
	AmountIn    *big.Int // exact (exact-in) or quoted (exact-out)
	AmountOut   *big.Int // quoted (exact-in) or exact (exact-out)
	Limit       *big.Int // minimum out or maximum in
	ImpactBps   int64
	SlippageBps int64
	Pools       []*poolState
	All         bool // "all": the balance is read at trade time
}

func (o *spotOrder) view() map[string]any {
	v := map[string]any{
		"give": o.InSymbol, "get": o.OutSymbol, "route": routeSymbols(o),
		"amount_in": amount.Format(o.AmountIn, o.InDecimals), "amount_out": amount.Format(o.AmountOut, o.OutDecimals),
		"price_impact_pct": float64(o.ImpactBps) / 100, "slippage_pct": float64(o.SlippageBps) / 100,
		"pool_fee_pct": 0.3 * float64(len(o.Markets)), "exact": map[bool]string{true: "output", false: "input"}[o.ExactOut],
	}
	if o.ExactOut {
		v["max_in"] = amount.Format(o.Limit, o.InDecimals)
	} else {
		v["min_out"] = amount.Format(o.Limit, o.OutDecimals)
	}
	return v
}

func routeSymbols(o *spotOrder) string {
	if len(o.Markets) == 2 {
		return o.InSymbol + " → wUSDT → " + o.OutSymbol
	}
	return o.InSymbol + " → " + o.OutSymbol
}

func (x *Ctx) slippageBps() (int64, error) {
	s := x.P.Str("slippage")
	if s == "" {
		return int64(x.Cfg.SlippageBps), nil
	}
	v, err := amount.Parse(strings.TrimSuffix(s, "%"), 2)
	if err != nil || v.Sign() <= 0 || v.Int64() > spotMaxSlipBps {
		return 0, errs.New(errs.InvalidInput, "--slippage is a percentage between 0.01 and 5 (for example 0.5).")
	}
	return v.Int64(), nil
}

func (x *Ctx) maxWait() (time.Duration, error) {
	n, err := x.P.Int("max_wait", spotDefaultWait)
	if err != nil || n < 0 || n > 600 {
		return 0, errs.New(errs.InvalidInput, "--max-wait is a number of seconds between 0 and 600.")
	}
	return time.Duration(n) * time.Second, nil
}

// planSpot turns (give, get, amount, exactOut) into an order with markets resolved; quotes are computed later
// from fresh reserves.
func (x *Ctx) planSpot(ctx context.Context, give, get string, amt string, exactOut bool) (*spotOrder, error) {
	wusdt := config.Addr(x.Cfg.Contracts.WUSDT)
	if spot.IsELN(give) || spot.IsELN(get) {
		return nil, errs.New(errs.ElnNotTradable, spot.ElnLockMessage)
	}
	o := &spotOrder{ExactOut: exactOut}
	resolve := func(s string) (common.Address, string, int, *spot.Market, error) {
		if spot.IsWUSDT(s, wusdt) {
			return wusdt, "wUSDT", 6, nil, nil
		}
		m, err := x.spotMarket(ctx, s)
		if err != nil {
			return common.Address{}, "", 0, nil, err
		}
		return m.Token, m.Display, m.Decimals, m, nil
	}
	var mIn, mOut *spot.Market
	var err error
	if o.InToken, o.InSymbol, o.InDecimals, mIn, err = resolve(give); err != nil {
		return nil, err
	}
	if o.OutToken, o.OutSymbol, o.OutDecimals, mOut, err = resolve(get); err != nil {
		return nil, err
	}
	if o.InToken == o.OutToken {
		return nil, errs.New(errs.InvalidInput, "Choose two different tokens.")
	}
	switch {
	case mIn == nil:
		o.Path, o.Markets = []common.Address{wusdt, o.OutToken}, []*spot.Market{mOut}
	case mOut == nil:
		o.Path, o.Markets = []common.Address{o.InToken, wusdt}, []*spot.Market{mIn}
	default:
		o.Path, o.Markets = []common.Address{o.InToken, wusdt, o.OutToken}, []*spot.Market{mIn, mOut}
	}
	if o.SlippageBps, err = x.slippageBps(); err != nil {
		return nil, err
	}
	if strings.EqualFold(amt, "all") {
		if exactOut {
			return nil, errs.New(errs.InvalidInput, "\"all\" only works for the amount you give.")
		}
		o.All = true
		return o, nil
	}
	dec := o.InDecimals
	if exactOut {
		dec = o.OutDecimals
	}
	v, err := amount.ParsePositive(amt, dec)
	if err != nil {
		return nil, errs.Newf(errs.InvalidInput, "Amount: %v", err)
	}
	if exactOut {
		o.AmountOut = v
	} else {
		o.AmountIn = v
	}
	return o, nil
}

// quote computes amounts from pool states.
func (o *spotOrder) quote(states []*poolState) error {
	o.Pools = states
	hops := make([]spot.Hop, len(states))
	for i, st := range states {
		// Direction: the first pool of a sell or of a two-hop swap is base → wUSDT.
		baseIn := o.Path[i] == st.M.Token
		if baseIn {
			hops[i] = spot.Hop{ReserveIn: st.ReserveBase, ReserveOut: st.ReserveQuote}
		} else {
			hops[i] = spot.Hop{ReserveIn: st.ReserveQuote, ReserveOut: st.ReserveBase}
		}
	}
	var err error
	if o.ExactOut {
		if o.AmountIn, err = spot.QuoteExactOut(o.AmountOut, hops); err != nil {
			return errs.New(errs.NoRoute, "The pool cannot provide that amount.").WithHint("Buy a smaller amount.")
		}
		o.Limit = spot.MaxIn(o.AmountIn, o.SlippageBps)
	} else {
		if o.AmountOut, err = spot.QuoteExactIn(o.AmountIn, hops); err != nil {
			return errs.New(errs.InvalidInput, "The amount is too small: the trade would return nothing.")
		}
		o.Limit = spot.MinOut(o.AmountOut, o.SlippageBps)
		if o.Limit.Sign() == 0 {
			return errs.New(errs.InvalidInput, "The amount is too small: the minimum received rounds to zero.")
		}
	}
	o.ImpactBps = spot.PriceImpactBps(hops, o.AmountIn)
	if o.ImpactBps >= spot.MaxImpactBps {
		return errs.Newf(errs.PriceImpactTooHigh, "Price impact %.2f%% is above the 15%% limit.", float64(o.ImpactBps)/100).WithHint("Trade a smaller amount.")
	}
	return nil
}

// readPools reads every pool of the order; with wait > 0 it waits (like the website) until all are in line with
// the global price.
func (x *Ctx) readPools(ctx context.Context, o *spotOrder, wait time.Duration) ([]*poolState, error) {
	start := time.Now()
	announced := false
	for {
		states := make([]*poolState, len(o.Markets))
		ready := true
		for i, m := range o.Markets {
			st, err := x.readPool(ctx, m)
			if err != nil {
				return nil, err
			}
			states[i] = st
			ready = ready && st.InSync
		}
		if ready || wait == 0 && !x.Cmd.ReadOnly {
			if !ready {
				return nil, notReady(states)
			}
			return states, nil
		}
		if x.Cmd.ReadOnly {
			return states, nil
		}
		if time.Since(start) > wait {
			return nil, notReady(states)
		}
		if !announced {
			x.Note("Waiting for the pool to match the global price (market makers keep it in line)…")
			announced = true
		}
		select {
		case <-ctx.Done():
			return nil, ctx.Err()
		case <-time.After(time.Second):
		}
	}
}

func notReady(states []*poolState) error {
	for _, st := range states {
		if !st.InSync {
			why := fmt.Sprintf("its price %s is %.1f bps away from the global price %s", amount.Price(st.Mid), (st.Mid/st.Reference-1)*10_000, amount.Price(st.Reference))
			if !st.FeedOK || st.FeedAge >= spotFeedMaxAge || st.Reference <= 0 {
				why = "the global price feed is not fresh"
			}
			return errs.Newf(errs.PoolNotReady, "The %s market is not ready right now (%s).", st.M.Display, why).WithHint("Please try again in a moment, or raise --max-wait.")
		}
	}
	return errs.New(errs.PoolNotReady, "The market is not ready right now. Please try again in a moment.")
}

func spotQuoteCmd(ctx context.Context, x *Ctx) (*Result, error) {
	var o *spotOrder
	var err error
	switch x.P.Str("side") {
	case "buy":
		if x.P.Has("spend") {
			o, err = x.planSpot(ctx, "wUSDT", x.P.Str("market"), x.P.Str("spend"), false)
		} else {
			o, err = x.planSpot(ctx, "wUSDT", x.P.Str("market"), x.P.Str("amount"), true)
		}
	case "sell":
		o, err = x.planSpot(ctx, x.P.Str("market"), "wUSDT", x.P.Str("amount"), false)
	case "swap":
		o, err = x.planSpot(ctx, x.P.Str("from"), x.P.Str("to"), x.P.Str("amount"), false)
	default:
		return nil, errs.New(errs.InvalidInput, "Say what to quote: buy, sell or swap. Example: elyon spot quote buy BTC --spend 100")
	}
	if err != nil {
		return nil, err
	}
	if o.All {
		return nil, errs.New(errs.InvalidInput, "Quotes need a number, not \"all\".")
	}
	states, err := x.readPools(ctx, o, 0)
	if err != nil {
		return nil, err
	}
	if err := o.quote(states); err != nil {
		return nil, err
	}
	v := o.view()
	ready := true
	for _, st := range states {
		ready = ready && st.InSync
	}
	v["ready_to_trade"] = ready
	return &Result{Data: v, Text: orderText("Quote", o) + map[bool]string{true: "", false: "  Note: the pool is catching up with the global price; a trade would wait (up to --max-wait seconds).\n"}[ready]}, nil
}

func orderText(title string, o *spotOrder) string {
	var b strings.Builder
	fmt.Fprintf(&b, "%s: %s\n", title, routeSymbols(o))
	if o.ExactOut {
		b.WriteString(line("You receive", amount.Group(amount.FormatSig(o.AmountOut, o.OutDecimals, 8))+" "+o.OutSymbol))
		b.WriteString(line("You pay about", amount.Group(amount.FormatSig(o.AmountIn, o.InDecimals, 8))+" "+o.InSymbol))
		b.WriteString(line("Maximum paid", amount.Group(amount.FormatSig(o.Limit, o.InDecimals, 8))+" "+o.InSymbol+fmt.Sprintf(" (slippage %.2f%%)", float64(o.SlippageBps)/100)))
	} else {
		b.WriteString(line("You pay", amount.Group(amount.FormatSig(o.AmountIn, o.InDecimals, 8))+" "+o.InSymbol))
		b.WriteString(line("You receive about", amount.Group(amount.FormatSig(o.AmountOut, o.OutDecimals, 8))+" "+o.OutSymbol))
		b.WriteString(line("Minimum received", amount.Group(amount.FormatSig(o.Limit, o.OutDecimals, 8))+" "+o.OutSymbol+fmt.Sprintf(" (slippage %.2f%%)", float64(o.SlippageBps)/100)))
	}
	b.WriteString(line("Price impact", fmt.Sprintf("%.2f%%", float64(o.ImpactBps)/100)))
	b.WriteString(line("Pool fee", fmt.Sprintf("%.2f%% of what you pay", 0.3*float64(len(o.Markets)))))
	if len(o.Pools) > 0 {
		st := o.Pools[0]
		b.WriteString(line("Pool price", amount.Price(st.Mid)+" wUSDT per "+st.M.Display+" (global "+amount.Price(st.Reference)+")"))
	}
	return b.String()
}

func spotBuyCmd(ctx context.Context, x *Ctx) (*Result, error) {
	if x.P.Has("spend") == x.P.Has("amount") {
		return nil, errs.New(errs.InvalidInput, "Say how much to buy: --spend <wUSDT> (for example `elyon spot buy BTC --spend 100`) or an exact amount (`elyon spot buy 0.01 BTC`).")
	}
	if x.P.Has("spend") {
		return x.executeSpot(ctx, "wUSDT", x.P.Str("market"), x.P.Str("spend"), false, "Bought")
	}
	return x.executeSpot(ctx, "wUSDT", x.P.Str("market"), x.P.Str("amount"), true, "Bought")
}

func spotSellCmd(ctx context.Context, x *Ctx) (*Result, error) {
	return x.executeSpot(ctx, x.P.Str("market"), "wUSDT", x.P.Str("amount"), false, "Sold")
}

func spotSwapCmd(ctx context.Context, x *Ctx) (*Result, error) {
	return x.executeSpot(ctx, x.P.Str("from"), x.P.Str("to"), x.P.Str("amount"), false, "Swapped")
}

func (x *Ctx) executeSpot(ctx context.Context, give, get, amt string, exactOut bool, verb string) (*Result, error) {
	if give == "" || get == "" || amt == "" {
		return nil, errs.Newf(errs.InvalidInput, "Missing market or amount. Usage: elyon %s", x.Cmd.Usage)
	}
	o, err := x.planSpot(ctx, give, get, amt, exactOut)
	if err != nil {
		return nil, err
	}
	sm, err := x.DEX().SpotMarkets(ctx)
	if err == nil && sm.Router != "" && common.HexToAddress(sm.Router) != config.Addr(x.Cfg.Contracts.Router) {
		return nil, errs.Newf(errs.ContractMismatch, "The DEX now trades through router %s, but this elyon-bot trusts %s.", sm.Router, x.Cfg.Contracts.Router).WithHint("Update elyon-bot before trading spot.")
	}
	c, err := x.Chain(ctx)
	if err != nil {
		return nil, err
	}
	me, err := x.Address()
	if err != nil {
		return nil, err
	}
	bal, err := c.TokenBalance(ctx, o.InToken, me)
	if err != nil {
		return nil, err
	}
	if o.All {
		if bal.Sign() == 0 {
			return nil, errs.Newf(errs.InsufficientBalance, "The wallet holds no %s.", o.InSymbol)
		}
		o.AmountIn = bal
	}
	if !o.ExactOut && o.AmountIn.Cmp(bal) > 0 {
		return nil, insufficient(o.InSymbol, o.AmountIn, bal, o.InDecimals, me)
	}
	wait, err := x.maxWait()
	if err != nil {
		return nil, err
	}
	states, err := x.readPools(ctx, o, wait)
	if err != nil {
		return nil, err
	}
	if err := o.quote(states); err != nil {
		return nil, err
	}
	spend := o.AmountIn
	if o.ExactOut {
		spend = o.Limit
	}
	if spend.Cmp(bal) > 0 {
		return nil, insufficient(o.InSymbol, spend, bal, o.InDecimals, me)
	}
	router := config.Addr(x.Cfg.Contracts.Router)
	if err := x.EnsureAllowance(ctx, o.InToken, router, spend, o.InSymbol, false); err != nil {
		return nil, err
	}
	deadline := big.NewInt(x.Now().Add(spotDeadline).Unix())
	var data []byte
	if o.ExactOut {
		data = chain.Pack(chain.RouterABI, "swapTokensForExactTokens", o.AmountOut, o.Limit, o.Path, me, deadline)
	} else {
		data = chain.Pack(chain.RouterABI, "swapExactTokensForTokens", o.AmountIn, o.Limit, o.Path, me, deadline)
	}
	label := fmt.Sprintf("swap %s → %s", o.InSymbol, o.OutSymbol)
	tx, err := x.Send(ctx, chain.TxRequest{To: router, Data: data, Label: label, GasMulNum: spotGasMulNum, GasMulDen: spotGasMulDen, GasAdd: spotGasAdd, GasFallback: spotGasFallback, Revert: chain.RevertContext{"symbol": o.InSymbol}})
	if err != nil {
		return nil, err
	}
	paid := transferred(tx.Receipt, o.InToken, me, true)
	got := transferred(tx.Receipt, o.OutToken, me, false)
	if paid.Sign() == 0 {
		paid = o.AmountIn
	}
	if got.Sign() == 0 {
		got = o.AmountOut
	}
	price := ""
	if base, quote := pickBaseQuote(o, paid, got); base != nil && base.Sign() > 0 {
		p := amount.ToFloat(quote, 6) / amount.ToFloat(base, o.baseDecimals())
		price = strconv.FormatFloat(p, 'f', -1, 64)
	}
	var b strings.Builder
	fmt.Fprintf(&b, "%s: paid %s %s, received %s %s\n", verb, amount.Group(amount.FormatSig(paid, o.InDecimals, 8)), o.InSymbol, amount.Group(amount.FormatSig(got, o.OutDecimals, 8)), o.OutSymbol)
	if price != "" {
		pf, _ := strconv.ParseFloat(price, 64)
		b.WriteString(line("Average price", amount.Price(pf)+" wUSDT per "+o.Markets[len(o.Markets)-1].Display))
	}
	b.WriteString(line("Route", routeSymbols(o)))
	b.WriteString(line("Price impact", fmt.Sprintf("%.2f%%", float64(o.ImpactBps)/100)))
	b.WriteString(line("Transaction", tx.Hash.Hex()))
	b.WriteString(line("Network fee", tx.Fee+" ELN"))
	data2 := o.view()
	data2["paid"], data2["received"], data2["tx"], data2["average_price_wusdt"] = amount.Format(paid, o.InDecimals), amount.Format(got, o.OutDecimals), tx.Hash.Hex(), price
	return &Result{Data: data2, Text: b.String()}, nil
}

func (o *spotOrder) baseDecimals() int {
	if len(o.Markets) > 0 {
		return o.Markets[len(o.Markets)-1].Decimals
	}
	return 18
}

// pickBaseQuote returns (base amount, wUSDT amount) of a single-hop trade for the average price.
func pickBaseQuote(o *spotOrder, paid, got *big.Int) (*big.Int, *big.Int) {
	if len(o.Markets) != 1 {
		return nil, nil
	}
	if o.InSymbol == "wUSDT" {
		return got, paid
	}
	return paid, got
}

func insufficient(sym string, need, have *big.Int, dec int, me common.Address) error {
	return errs.Newf(errs.InsufficientBalance, "Not enough %s: this needs %s %s and the wallet holds %s %s.", sym, amount.Group(amount.Format(need, dec)), sym, amount.Group(amount.Format(have, dec)), sym).
		With("needed", amount.Format(need, dec)).With("balance", amount.Format(have, dec)).
		WithHint("Send " + sym + " to " + me.Hex() + " or lower the amount.")
}

// transferred sums ERC-20 Transfer events of token from (out=true) or to (out=false) the wallet in a receipt.
func transferred(rec *types.Receipt, token, me common.Address, out bool) *big.Int {
	sum := new(big.Int)
	if rec == nil {
		return sum
	}
	topic := chain.ERC20ABI.Events["Transfer"].ID
	for _, l := range rec.Logs {
		if l.Address != token || len(l.Topics) != 3 || l.Topics[0] != topic || len(l.Data) < 32 {
			continue
		}
		from, to := common.BytesToAddress(l.Topics[1].Bytes()), common.BytesToAddress(l.Topics[2].Bytes())
		if (out && from == me) || (!out && to == me) {
			sum.Add(sum, new(big.Int).SetBytes(l.Data[:32]))
		}
	}
	return sum
}
