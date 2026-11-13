package app

import (
	"context"
	"fmt"
	"math"
	"math/big"
	"sort"
	"strconv"
	"strings"
	"time"

	"github.com/ethereum/go-ethereum/common"
	"github.com/ethereum/go-ethereum/core/types"

	"github.com/elyon-chain/elyon-bot/internal/amount"
	"github.com/elyon-chain/elyon-bot/internal/chain"
	"github.com/elyon-chain/elyon-bot/internal/dex"
	"github.com/elyon-chain/elyon-bot/internal/errs"
	"github.com/elyon-chain/elyon-bot/internal/futures"
)

var sizingParams = []Param{
	{Name: "margin", Help: "margin in wUSDT (isolated; at least 1)"},
	{Name: "size", Help: "position size in wUSDT (margin = size / leverage)"},
	{Name: "quantity", Help: "position size in the asset, e.g. 0.01 BTC"},
	{Name: "risk", Help: "wUSDT you accept to lose at the stop loss (needs --stop-loss); sets the size"},
	{Name: "leverage", Help: "leverage, e.g. 5 (1 to the market maximum)"},
	{Name: "take_profit", Help: "take-profit price (optional)"},
	{Name: "stop_loss", Help: "stop-loss price (optional)"},
	{Name: "approve_unlimited", Bool: true, Help: "approve wUSDT once for all futures trades (like the website's opt-in)"},
}

func init() {
	register(
		&Command{Name: "futures markets", Summary: "List perpetual futures markets (crypto, metals, indices, forex, stocks…).", Usage: "futures markets [--search gold] [--category metals] [--limit 50]", Access: Public, ReadOnly: true, Run: futMarketsCmd,
			Params: []Param{{Name: "search"}, {Name: "category", Help: "crypto, metals, indices, energy, forex or stocks"}, {Name: "limit", Help: "rows (default 50; 0 = all)"}}, Positional: fill("search"),
			Examples: []string{"elyon futures markets", "elyon futures markets --search gold", "elyon futures markets --category stocks --limit 0"}},
		&Command{Name: "futures price", Summary: "Show the live price, funding and limits of a futures market.", Usage: "futures price <MARKET>", Access: Public, ReadOnly: true, Run: futPriceCmd,
			Params: []Param{{Name: "market"}}, Positional: fill("market"), Examples: []string{"elyon futures price BTC"}},
		&Command{Name: "futures funding", Summary: "Show the funding rate of a market and what your positions there pay or receive.", Usage: "futures funding <MARKET>", Access: Public, ReadOnly: true, Run: futFundingCmd,
			Params: []Param{{Name: "market"}}, Positional: fill("market"), Examples: []string{"elyon futures funding BTC"}},
		&Command{Name: "futures open", Summary: "Open a long or short position at the market price (isolated margin), with optional take profit / stop loss.", Usage: "futures open long|short <MARKET> --margin <wUSDT> --leverage <x> [--take-profit P] [--stop-loss P]", Access: KeyNeeded, Run: futOpenCmd,
			Params: append([]Param{{Name: "side", Help: "long or short"}, {Name: "market"}}, sizingParams...), Positional: fill("side", "market"),
			Examples: []string{"elyon futures open long BTC --margin 10 --leverage 5", "elyon futures open short ETH --size 100 --leverage 10 --take-profit 1800 --stop-loss 2050", "elyon futures open long BTC --risk 5 --stop-loss 66000 --leverage 10"}},
		&Command{Name: "futures close", Summary: "Close a position at the market price, completely or a percentage of it.", Usage: "futures close <positionId> [--percent 50]", Access: KeyNeeded, Run: futCloseCmd,
			Params: []Param{{Name: "id", Help: "position id"}, {Name: "percent", Help: "part to close, 1–100 (default 100)"}}, Positional: fill("id"),
			Examples: []string{"elyon futures close 6253401", "elyon futures close 6253401 --percent 50"}},
		&Command{Name: "futures close-all", Summary: "Close every open position (optionally only of one market).", Usage: "futures close-all [--market BTC]", Access: KeyNeeded, Run: futCloseAllCmd,
			Params: []Param{{Name: "market"}}, Positional: fill("market"), Examples: []string{"elyon futures close-all", "elyon futures close-all --market BTC"}},
		&Command{Name: "futures set-tp-sl", Summary: "Set, change or remove the take profit / stop loss of a position (\"none\" removes).", Usage: "futures set-tp-sl <positionId> [--take-profit P|none] [--stop-loss P|none]", Access: KeyNeeded, Run: futSetTPSLCmd,
			Params: []Param{{Name: "id"}, {Name: "take_profit"}, {Name: "stop_loss"}}, Positional: fill("id"),
			Examples: []string{"elyon futures set-tp-sl 6253401 --take-profit 80000 --stop-loss 65000", "elyon futures set-tp-sl 6253401 --stop-loss none"}},
		&Command{Name: "futures positions", Summary: "List open positions with live PnL, liquidation price and TP/SL.", Usage: "futures positions [--market BTC]", Access: AddressOnly, ReadOnly: true, Run: futPositionsCmd,
			Params: []Param{{Name: "market"}}, Positional: fill("market")},
		&Command{Name: "futures limit", Summary: "Place a limit order: the position opens when the price reaches your limit (nothing is taken until then).", Usage: "futures limit long|short <MARKET> --price <P> --margin <wUSDT> --leverage <x> [--expires 7d] [--take-profit P] [--stop-loss P]", Access: KeyNeeded, Run: futLimitCmd,
			Params: append([]Param{{Name: "side"}, {Name: "market"}, {Name: "price", Help: "limit price"}, {Name: "expires", Help: "how long the order rests: 30m, 12h, 7d … up to 90d (default 30d)"}}, sizingParams...), Positional: fill("side", "market"),
			Examples: []string{"elyon futures limit long BTC --price 65000 --margin 10 --leverage 5 --expires 7d", "elyon futures limit short ETH --price 2100 --size 50 --leverage 5 --take-profit 1900"}},
		&Command{Name: "futures orders", Summary: "List your open limit orders (--all also shows filled, cancelled and closed ones).", Usage: "futures orders [--all]", Access: AddressOnly, ReadOnly: true, Run: futOrdersCmd,
			Params: []Param{{Name: "all", Bool: true}}},
		&Command{Name: "futures cancel", Summary: "Cancel a limit order (nothing was taken from the wallet, so nothing is returned).", Usage: "futures cancel <orderId>", Access: KeyNeeded, Run: futCancelCmd,
			Params: []Param{{Name: "id", Help: "order id"}}, Positional: fill("id"), Examples: []string{"elyon futures cancel 12"}},
		&Command{Name: "futures cancel-all", Summary: "Cancel every open limit order (optionally only of one market).", Usage: "futures cancel-all [--market BTC]", Access: KeyNeeded, Run: futCancelAllCmd,
			Params: []Param{{Name: "market"}}, Positional: fill("market")},
		&Command{Name: "futures history", Summary: "Show closed positions and past limit orders (as indexed by the DEX).", Usage: "futures history [--limit 20]", Access: AddressOnly, ReadOnly: true, Run: futHistoryCmd,
			Params: []Param{{Name: "limit"}}},
	)
}

func futMarketsCmd(ctx context.Context, x *Ctx) (*Result, error) {
	env, err := x.futures(ctx, false)
	if err != nil {
		return nil, err
	}
	q := strings.ToUpper(strings.TrimSpace(x.P.Str("search")))
	cat := strings.ToLower(x.P.Str("category"))
	var ms []dex.FuturesMarket
	for _, m := range env.API.Markets {
		if cat != "" && m.Category != cat {
			continue
		}
		if q != "" && !strings.Contains(m.Base, q) && !(m.Name != nil && strings.Contains(strings.ToUpper(*m.Name), q)) {
			continue
		}
		ms = append(ms, m)
	}
	if q != "" {
		sort.SliceStable(ms, func(i, j int) bool {
			ri, rj := rankF(ms[i], q), rankF(ms[j], q)
			if ri != rj {
				return ri > rj
			}
			return ms[i].Amount24 > ms[j].Amount24
		})
	}
	total := len(ms)
	limit, err := x.P.Int("limit", 50)
	if err != nil {
		return nil, err
	}
	if limit > 0 && int(limit) < len(ms) {
		ms = ms[:limit]
	}
	var b strings.Builder
	fmt.Fprintf(&b, "%-14s %-9s %16s %9s %10s %8s  %s\n", "MARKET", "TYPE", "LAST (wUSDT)", "24H", "FUNDING", "MAX LEV", "STATUS")
	for _, m := range ms {
		status := "open"
		if m.Closed {
			status = "closed (outside trading hours)"
		} else if m.CloseOnly {
			status = "close-only"
		}
		fr := "—"
		if m.FundingRate != nil {
			fr = fmt.Sprintf("%.4f%%", *m.FundingRate*100)
		}
		fmt.Fprintf(&b, "%-14s %-9s %16s %+8.2f%% %10s %7dx  %s\n", m.Base, m.Category, amount.Price(lastPrice(&m)), m.Change24Pct, fr, m.MaxLeverage, status)
	}
	fmt.Fprintf(&b, "\n%d of %d markets shown. Fee: 0.10%% of the position size on open and on close. Isolated margin only.\n", len(ms), total)
	return &Result{Data: map[string]any{"count": total, "shown": len(ms), "markets": ms, "contract": env.API.Contract}, Text: b.String()}, nil
}

func rankF(m dex.FuturesMarket, q string) int {
	switch {
	case m.Base == q:
		return 3
	case strings.HasPrefix(m.Base, q):
		return 2
	case strings.Contains(m.Base, q):
		return 1
	}
	return 0
}

func futPriceCmd(ctx context.Context, x *Ctx) (*Result, error) {
	env, err := x.futures(ctx, false)
	if err != nil {
		return nil, err
	}
	m, err := resolveFutures(x.P.Str("market"), env)
	if err != nil {
		return nil, err
	}
	if mk, err := x.DEX().Marks(ctx, []string{m.Symbol}); err == nil {
		if v, ok := mk[m.Symbol]; ok && v.Last != nil {
			m.Last, m.Fair, m.Index, m.FundingRate, m.Change24Pct, m.At = v.Last, v.Fair, v.Index, v.FundingRate, v.Change24Pct, v.At
		}
	}
	var b strings.Builder
	fmt.Fprintf(&b, "%s (%s)\n", marketTitle(m), m.Symbol)
	b.WriteString(line("Last price", amount.Price(futures.FloatOrZero(m.Last))+" wUSDT  (positions open and close at this price)"))
	b.WriteString(line("Mark price", amount.Price(futures.FloatOrZero(m.Fair))+" wUSDT"))
	b.WriteString(line("Index price", amount.Price(futures.FloatOrZero(m.Index))+" wUSDT"))
	b.WriteString(line("24h change", fmt.Sprintf("%+.2f%%  (high %s, low %s)", m.Change24Pct, amount.Price(futures.FloatOrZero(m.High24)), amount.Price(futures.FloatOrZero(m.Low24)))))
	if m.FundingRate != nil {
		b.WriteString(line("Funding / 8h", fmt.Sprintf("%.4f%% (%s)", *m.FundingRate*100, fundingWho(*m.FundingRate))))
	}
	b.WriteString(line("Max leverage", fmt.Sprintf("%dx (safe max %dx with fees)", m.MaxLeverage, futures.MaxSafeLeverage(m.MaxLeverage, m.MmrPpm, m.FeePpm))))
	b.WriteString(line("Fee", fmt.Sprintf("%.3f%% of the position size, on open and on close", float64(m.FeePpm)/1e4)))
	b.WriteString(line("Maintenance", fmt.Sprintf("%.2f%%", float64(m.MmrPpm)/1e4)))
	status := "open for trading"
	if m.Closed {
		status = "closed: outside the underlying market's trading hours"
	} else if m.CloseOnly {
		status = "close-only: new positions are paused (last and mark prices are apart)"
	}
	b.WriteString(line("Status", status))
	return &Result{Data: map[string]any{"market": m, "safe_max_leverage": futures.MaxSafeLeverage(m.MaxLeverage, m.MmrPpm, m.FeePpm)}, Text: b.String()}, nil
}

func fundingWho(rate float64) string {
	switch {
	case rate > 0:
		return "longs pay shorts"
	case rate < 0:
		return "shorts pay longs"
	}
	return "nobody pays"
}

// nextFunding returns the next 00:00 / 08:00 / 16:00 UTC.
func nextFunding(now time.Time) time.Time {
	t := now.UTC().Truncate(time.Hour)
	for {
		t = t.Add(time.Hour)
		if t.Hour()%8 == 0 {
			return t
		}
	}
}

func futFundingCmd(ctx context.Context, x *Ctx) (*Result, error) {
	env, err := x.futures(ctx, false)
	if err != nil {
		return nil, err
	}
	m, err := resolveFutures(x.P.Str("market"), env)
	if err != nil {
		return nil, err
	}
	rate := futures.FloatOrZero(m.FundingRate)
	if mk, err := x.DEX().Marks(ctx, []string{m.Symbol}); err == nil {
		if v, ok := mk[m.Symbol]; ok && v.FundingRate != nil {
			rate = *v.FundingRate
		}
	}
	next := nextFunding(x.Now())
	var b strings.Builder
	fmt.Fprintf(&b, "Funding of %s\n", m.Symbol)
	b.WriteString(line("Rate / 8h", fmt.Sprintf("%.4f%% (%s)", rate*100, fundingWho(rate))))
	b.WriteString(line("Next funding", next.Format("2006-01-02 15:04 UTC")+fmt.Sprintf(" (in %s)", next.Sub(x.Now()).Round(time.Minute))))
	b.WriteString(line("Schedule", "every 8 hours at 00:00, 08:00 and 16:00 UTC; settled when the position closes"))
	data := map[string]any{"market": m.Symbol, "rate_per_8h": rate, "next_funding": next, "who_pays": fundingWho(rate)}
	if me, err := x.Address(); err == nil {
		if ps, err := x.positions(ctx, env, me, true); err == nil {
			var mine []map[string]any
			price := lastPrice(m)
			for _, p := range ps {
				if p.Symbol != m.Symbol {
					continue
				}
				size := amount.ToFloat(p.SizeE18, 18)
				pay := size * price * rate
				if !p.Long {
					pay = -pay
				}
				word := "pays"
				if pay < 0 {
					word = "receives"
				}
				b.WriteString(line(fmt.Sprintf("Position #%d", p.ID), fmt.Sprintf("%s ≈ %.6f wUSDT at the next funding", word, math.Abs(pay))))
				mine = append(mine, map[string]any{"id": p.ID, "side": p.Side, "estimated_payment_wusdt": fmt.Sprintf("%.6f", pay)})
			}
			data["your_positions"] = mine
		}
	}
	return &Result{Data: data, Text: b.String()}, nil
}

// sizing is the resolved order size.
type sizing struct {
	Margin   *big.Int
	Leverage int64
	Notional *big.Int
	Fee      *big.Int
	Cost     *big.Int
	TP, SL   *big.Int // 1e18, nil = none
}

func optPrice(p Params, k string) (*big.Int, *float64, error) {
	s := p.Str(k)
	if s == "" || strings.EqualFold(s, "none") || strings.EqualFold(s, "off") || s == "0" {
		return nil, nil, nil
	}
	v, err := futures.PriceToE18(s)
	if err != nil {
		return nil, nil, errs.Newf(errs.InvalidInput, "%s: %v", strings.ReplaceAll(k, "_", " "), err)
	}
	f := amount.ToFloat(v, 18)
	return v, &f, nil
}

// size resolves margin / size / quantity / risk and leverage, and checks every website rule at entry price ref.
func (x *Ctx) size(env *futuresEnv, m *dex.FuturesMarket, long bool, ref float64, limit bool) (*sizing, error) {
	if !x.P.Has("leverage") {
		return nil, errs.New(errs.InvalidInput, "Choose the leverage with --leverage, for example --leverage 5.")
	}
	lev, err := x.P.Int("leverage", 0)
	if err != nil {
		return nil, err
	}
	if lev < 1 || lev > m.MaxLeverage {
		return nil, errs.Newf(errs.LeverageTooHigh, "Leverage must be between 1 and %d on %s.", m.MaxLeverage, m.Symbol)
	}
	if safe := futures.MaxSafeLeverage(m.MaxLeverage, m.MmrPpm, m.FeePpm); lev > safe {
		return nil, errs.Newf(errs.LeverageTooHigh, "Choose leverage of %dx or lower on %s to cover maintenance and closing fees.", safe, m.Symbol)
	}
	tp, tpf, err := optPrice(x.P, "take_profit")
	if err != nil {
		return nil, err
	}
	sl, slf, err := optPrice(x.P, "stop_loss")
	if err != nil {
		return nil, err
	}
	modes := 0
	for _, k := range []string{"margin", "size", "quantity", "risk"} {
		if x.P.Has(k) {
			modes++
		}
	}
	if modes != 1 {
		return nil, errs.New(errs.InvalidInput, "Size the order with exactly one of --margin <wUSDT>, --size <wUSDT>, --quantity <asset amount> or --risk <wUSDT> (with --stop-loss).")
	}
	s := &sizing{Leverage: lev, TP: tp, SL: sl}
	levBig := big.NewInt(lev)
	switch {
	case x.P.Has("margin"):
		if s.Margin, err = x.P.Amount("margin", 6); err != nil {
			return nil, err
		}
	case x.P.Has("size"):
		n, err := x.P.Amount("size", 6)
		if err != nil {
			return nil, err
		}
		s.Margin = futures.MarginFromNotional(n, lev)
	case x.P.Has("quantity"):
		q, err := x.P.Amount("quantity", 18)
		if err != nil {
			return nil, err
		}
		if ref <= 0 {
			return nil, errs.New(errs.QuoteUnavailable, "No current price to convert the quantity.")
		}
		pe18, _ := amount.FromFloat(ref, 18)
		notional := new(big.Int).Mul(q, pe18)
		notional.Quo(notional, amount.Pow10(30)) // 1e18 qty × 1e18 price → 1e6 wUSDT
		s.Margin = futures.MarginFromNotional(notional, lev)
	case x.P.Has("risk"):
		if slf == nil {
			return nil, errs.New(errs.InvalidInput, "--risk needs a --stop-loss price: the size is the one that loses exactly that amount at the stop.")
		}
		r, err := strconv.ParseFloat(x.P.Str("risk"), 64)
		if err != nil || r <= 0 {
			return nil, errs.New(errs.InvalidInput, "--risk must be a positive wUSDT amount.")
		}
		n := futures.NotionalForRisk(r, ref, *slf, long, float64(m.FeePpm)/futures.PPM)
		if n <= 0 {
			return nil, errs.New(errs.TriggerInvalid, "The stop loss is on the wrong side of the price, so no size can be derived from --risk.")
		}
		nb, _ := amount.FromFloat(math.Floor(n*100)/100, 6)
		s.Margin = futures.MarginFromNotional(nb, lev)
	}
	if s.Margin.Cmp(futures.MinMargin) < 0 {
		return nil, errs.Newf(errs.InvalidOrder, "Minimum margin is 1 wUSDT (this order would use %s wUSDT).", amount.Format(s.Margin, 6)).WithHint("Raise the size or lower the leverage.")
	}
	s.Notional = new(big.Int).Mul(s.Margin, levBig)
	if s.Notional.Cmp(env.MaxNotl) > 0 {
		return nil, errs.Newf(errs.TooLarge, "Position size %s wUSDT is above the %s wUSDT limit per position.", amount.Group(amount.Format(s.Notional, 6)), amount.Group(amount.Format(env.MaxNotl, 6))).WithHint("Lower the margin or the leverage.")
	}
	s.Fee = futures.Fee(s.Margin, lev, m.FeePpm)
	s.Cost = new(big.Int).Add(s.Margin, s.Fee)
	liq := futures.EstimateLiquidation(ref, lev, m.MmrPpm, m.FeePpm, long)
	if err := futures.TriggerProblems(long, ref, liq, tpf, slf, limit); err != nil {
		return nil, err
	}
	return s, nil
}

func parseSide(s string) (bool, error) {
	switch strings.ToLower(strings.TrimSpace(s)) {
	case "long", "buy":
		return true, nil
	case "short", "sell":
		return false, nil
	}
	return false, errs.New(errs.InvalidInput, "Say long or short, for example `elyon futures open long BTC …`.")
}

func zeroIfNil(v *big.Int) *big.Int {
	if v == nil {
		return new(big.Int)
	}
	return v
}

func (x *Ctx) wantUnlimited() bool {
	b, _ := x.P.Bool("approve_unlimited")
	return b || x.Cfg.ApproveUnlimited
}

func (x *Ctx) requireWUSDT(ctx context.Context, env *futuresEnv, need *big.Int) error {
	c, err := x.Chain(ctx)
	if err != nil {
		return err
	}
	me, err := x.Address()
	if err != nil {
		return err
	}
	bal, err := c.TokenBalance(ctx, env.WUSDT, me)
	if err != nil {
		return err
	}
	if bal.Cmp(need) < 0 {
		return insufficient("wUSDT", need, bal, 6, me)
	}
	return nil
}

func futOpenCmd(ctx context.Context, x *Ctx) (*Result, error) {
	long, err := parseSide(x.P.Str("side"))
	if err != nil {
		return nil, err
	}
	env, err := x.futures(ctx, true)
	if err != nil {
		return nil, err
	}
	m, err := resolveFutures(x.P.Str("market"), env)
	if err != nil {
		return nil, err
	}
	if m.Closed {
		return nil, errs.Newf(errs.MarketClosed, "%s is outside its trading hours: its price is frozen, so positions cannot be opened right now.", m.Symbol).WithHint("Trading resumes automatically when the underlying market reopens.")
	}
	if m.CloseOnly {
		return nil, errs.Newf(errs.MarketCloseOnly, "New positions are paused on %s (its last and mark prices are too far apart). Open positions can still be closed.", m.Symbol)
	}
	ref := lastPrice(m)
	s, err := x.size(env, m, long, ref, false)
	if err != nil {
		return nil, err
	}
	if err := x.requireWUSDT(ctx, env, s.Cost); err != nil {
		return nil, err
	}
	if err := x.EnsureAllowance(ctx, env.WUSDT, env.Triggers, futures.ApprovalNeed(s.Margin, s.Leverage, m.FeePpm), "wUSDT", x.wantUnlimited()); err != nil {
		return nil, err
	}
	var tx *chain.TxResult
	var q *dex.SignedQuote
	for attempt := 0; ; attempt++ {
		x.Note("Fetching a signed market price…")
		var qt quoteTuple
		q, qt, err = x.signedQuote(ctx, m.Symbol, env.Market, m.ID, env.MaxAge)
		if err != nil {
			return nil, err
		}
		// The contract checks TP/SL against the real fill price: re-check them there (website behaviour).
		liq := futures.EstimateLiquidation(q.Price, s.Leverage, m.MmrPpm, m.FeePpm, long)
		if err := futures.TriggerProblems(long, q.Price, liq, ratOrNil(s.TP), ratOrNil(s.SL), false); err != nil {
			return nil, errs.As(err).WithHint("The price moved; nothing was opened. Adjust the take profit / stop loss and retry.")
		}
		before := len(x.res.Txs)
		data := chain.Pack(chain.TriggersABI, "open", big.NewInt(m.ID), long, s.Margin, uint32(s.Leverage), qt, zeroIfNil(s.TP), zeroIfNil(s.SL))
		tx, err = x.Send(ctx, chain.TxRequest{To: env.Triggers, Data: data, Label: fmt.Sprintf("open %s %s %dx", sideWord(long), m.Base, s.Leverage), Revert: chain.RevertContext{"symbol": "wUSDT"}})
		if err != nil && errs.Is(err, errs.QuoteExpired) && len(x.res.Txs) == before && attempt < 2 {
			continue // the quote aged during estimation: fetch a fresh one (nothing was sent)
		}
		if err != nil {
			return nil, err
		}
		break
	}
	ev := findEvent(tx.Receipt, env.Market, chain.PerpABI, "PositionOpened")
	res := map[string]any{"market": m.Symbol, "side": sideWord(long), "leverage": s.Leverage, "margin": amount.Format(s.Margin, 6), "size_wusdt": amount.Format(s.Notional, 6), "tx": tx.Hash.Hex(), "quote_price": q.Price}
	var b strings.Builder
	if ev != nil {
		id := ev.topics[1].Big()
		entry, fee, liqE := ev.vals["entryPriceE18"].(*big.Int), ev.vals["fee"].(*big.Int), ev.vals["liquidationPriceE18"].(*big.Int)
		res["position_id"], res["entry_price"], res["fee_paid"], res["liquidation_price"] = id.Uint64(), amount.Format(entry, 18), amount.Format(fee, 6), amount.Format(liqE, 18)
		fmt.Fprintf(&b, "Opened %s %s %dx at %s wUSDT\n", strings.ToUpper(sideWord(long)), m.Base, s.Leverage, amount.PriceE18(entry))
		b.WriteString(line("Position", "#"+id.String()))
		b.WriteString(line("Margin", amount.Format(s.Margin, 6)+" wUSDT (isolated)"))
		sizeBase := new(big.Rat).SetFrac(new(big.Int).Mul(s.Notional, amount.Pow10(12)), entry)
		fs, _ := sizeBase.Float64()
		b.WriteString(line("Size", amount.Format(s.Notional, 6)+" wUSDT ≈ "+strconv.FormatFloat(fs, 'g', 6, 64)+" "+m.Base))
		b.WriteString(line("Fee paid", amount.Format(fee, 6)+" wUSDT"))
		liqF := amount.ToFloat(liqE, 18)
		b.WriteString(line("Liquidation", fmt.Sprintf("%s wUSDT (%+.2f%%) — at this price the whole margin is lost", amount.Price(liqF), (liqF/amount.ToFloat(entry, 18)-1)*100)))
	} else {
		fmt.Fprintf(&b, "Opened %s %s %dx (position id not found in the receipt; see `elyon futures positions`)\n", strings.ToUpper(sideWord(long)), m.Base, s.Leverage)
	}
	b.WriteString(line("Take profit", priceOrNone(s.TP)))
	b.WriteString(line("Stop loss", priceOrNone(s.SL)))
	b.WriteString(line("Transaction", tx.Hash.Hex()))
	if s.TP != nil {
		res["take_profit"] = amount.Format(s.TP, 18)
	}
	if s.SL != nil {
		res["stop_loss"] = amount.Format(s.SL, 18)
	}
	return &Result{Data: res, Text: b.String()}, nil
}

func ratOrNil(v *big.Int) *float64 {
	if v == nil {
		return nil
	}
	f := amount.ToFloat(v, 18)
	return &f
}

func priceOrNone(v *big.Int) string {
	if v == nil || v.Sign() == 0 {
		return "none"
	}
	return amount.PriceE18(v)
}

func sideWord(long bool) string { return map[bool]string{true: "long", false: "short"}[long] }

// event is a decoded log.
type event struct {
	topics []common.Hash
	vals   map[string]any
}

func findEvent(rec *types.Receipt, addr common.Address, a interface {
}, name string) *event {
	if rec == nil {
		return nil
	}
	var ab = chain.PerpABI
	switch name {
	case "LimitPlaced", "LimitCancelled":
		ab = chain.LimitABI
	case "TriggersSet", "Closed", "Reduced":
		ab = chain.TriggersABI
	case "Bought":
		ab = chain.GasSaleABI
	}
	ev, ok := ab.Events[name]
	if !ok {
		return nil
	}
	for _, l := range rec.Logs {
		if l.Address != addr || len(l.Topics) == 0 || l.Topics[0] != ev.ID {
			continue
		}
		vals := map[string]any{}
		if err := ev.Inputs.NonIndexed().UnpackIntoMap(vals, l.Data); err != nil {
			continue
		}
		return &event{topics: l.Topics, vals: vals}
	}
	return nil
}

func parseID(p Params, what string) (uint64, error) {
	s := strings.TrimPrefix(p.Str("id"), "#")
	if s == "" {
		return 0, errs.Newf(errs.InvalidInput, "Give the %s id, for example `elyon futures close 6253401`.", what)
	}
	n, err := strconv.ParseUint(s, 10, 64)
	if err != nil {
		return 0, errs.Newf(errs.InvalidInput, "%q is not a %s id (a number).", s, what)
	}
	return n, nil
}

func futCloseCmd(ctx context.Context, x *Ctx) (*Result, error) {
	id, err := parseID(x.P, "position")
	if err != nil {
		return nil, err
	}
	bps := int64(10_000)
	if x.P.Has("percent") {
		if bps, err = amount.ParsePercent(x.P.Str("percent")); err != nil {
			return nil, errs.New(errs.InvalidInput, "--percent must be between 1 and 100.")
		}
	}
	env, err := x.futures(ctx, true)
	if err != nil {
		return nil, err
	}
	me, err := x.Address()
	if err != nil {
		return nil, err
	}
	p, err := x.findPosition(ctx, env, me, id)
	if err != nil {
		return nil, err
	}
	out, err := x.closeOne(ctx, env, p, bps)
	if err != nil {
		return nil, err
	}
	return &Result{Data: out.data, Text: out.text}, nil
}

type closeOut struct {
	data map[string]any
	text string
}

func (x *Ctx) closeOne(ctx context.Context, env *futuresEnv, p *Position, bps int64) (*closeOut, error) {
	if !p.Open {
		return nil, errs.Newf(errs.AlreadyClosed, "Position #%d is already closed.", p.ID)
	}
	if m, ok := env.byID[p.MarketID]; ok && p.Contract == env.Market && m.Closed {
		return nil, errs.Newf(errs.MarketClosed, "%s is outside its trading hours, so position #%d cannot be closed right now.", m.Symbol, p.ID).WithHint("It stays open; closing becomes available when the market reopens.")
	}
	closeSize := p.SizeE18
	partial := bps < 10_000
	if partial {
		if !p.Partial {
			return nil, errs.Newf(errs.InvalidOrder, "Position #%d is on the previous market contract, which only closes whole positions.", p.ID).WithHint("Close it completely (without --percent).")
		}
		closeSize = new(big.Int).Quo(new(big.Int).Mul(p.SizeE18, big.NewInt(bps)), big.NewInt(10_000))
		if closeSize.Sign() == 0 || closeSize.Cmp(p.SizeE18) >= 0 {
			return nil, errs.New(errs.InvalidOrder, "Choose a part smaller than the whole position, or close the whole position.")
		}
	}
	var tx *chain.TxResult
	var err error
	for attempt := 0; ; attempt++ {
		_, qt, qerr := x.signedQuote(ctx, p.Symbol, p.Contract, p.MarketID, maxAgeFor(env))
		if qerr != nil {
			return nil, qerr
		}
		id := new(big.Int).SetUint64(p.ID)
		var req chain.TxRequest
		switch {
		case partial:
			req = chain.TxRequest{To: p.Router, Data: chain.Pack(chain.TriggersABI, "reduce", id, closeSize, qt)}
		case p.Router != (common.Address{}):
			req = chain.TxRequest{To: p.Router, Data: chain.Pack(chain.TriggersABI, "close", id, qt)}
		default:
			req = chain.TxRequest{To: p.Contract, Data: chain.Pack(chain.PerpABI, "close", id, qt)}
		}
		req.Label = fmt.Sprintf("close position #%d", p.ID)
		if partial {
			req.Label = fmt.Sprintf("close %s%% of position #%d", strings.TrimRight(strings.TrimRight(fmt.Sprintf("%.2f", float64(bps)/100), "0"), "."), p.ID)
		}
		before := len(x.res.Txs)
		tx, err = x.Send(ctx, req)
		if err != nil && errs.Is(err, errs.QuoteExpired) && len(x.res.Txs) == before && attempt < 2 {
			continue
		}
		if err != nil {
			return nil, err
		}
		break
	}
	data := map[string]any{"position_id": p.ID, "market": p.Symbol, "side": p.Side, "tx": tx.Hash.Hex(), "partial": partial}
	var b strings.Builder
	if partial {
		ev := findEvent(tx.Receipt, p.Contract, chain.PerpABI, "PositionReduced")
		fmt.Fprintf(&b, "Closed %.4g%% of position #%d (%s %s)\n", float64(bps)/100, p.ID, strings.ToUpper(p.Side), p.Symbol)
		if ev != nil {
			exit, pnl, fee, pay := ev.vals["exitPriceE18"].(*big.Int), ev.vals["pnl"].(*big.Int), ev.vals["fee"].(*big.Int), ev.vals["payout"].(*big.Int)
			data["exit_price"], data["pnl"], data["fee"], data["payout"], data["closed_size_base"] = amount.Format(exit, 18), amount.Format(pnl, 6), amount.Format(fee, 6), amount.Format(pay, 6), amount.Format(closeSize, 18)
			b.WriteString(line("Exit price", amount.PriceE18(exit)+" wUSDT"))
			b.WriteString(line("PnL of the part", signed(pnl)+" wUSDT"))
			b.WriteString(line("Closing fee", amount.Format(fee, 6)+" wUSDT"))
			b.WriteString(line("Paid to wallet", amount.Format(pay, 6)+" wUSDT"))
			b.WriteString(line("Rest", "stays open with the same entry price, leverage, liquidation price and TP/SL"))
		}
	} else {
		ev := findEvent(tx.Receipt, p.Contract, chain.PerpABI, "PositionClosed")
		fmt.Fprintf(&b, "Closed position #%d (%s %s)\n", p.ID, strings.ToUpper(p.Side), p.Symbol)
		if ev != nil {
			exit, pnl, fund, fee, pay := ev.vals["exitPriceE18"].(*big.Int), ev.vals["pnl"].(*big.Int), ev.vals["funding"].(*big.Int), ev.vals["fee"].(*big.Int), ev.vals["payout"].(*big.Int)
			data["exit_price"], data["pnl"], data["funding"], data["fee"], data["payout"] = amount.Format(exit, 18), amount.Format(pnl, 6), amount.Format(fund, 6), amount.Format(fee, 6), amount.Format(pay, 6)
			b.WriteString(line("Exit price", amount.PriceE18(exit)+" wUSDT (entry "+amount.PriceE18(p.EntryE18)+")"))
			b.WriteString(line("PnL", signed(pnl)+" wUSDT"))
			b.WriteString(line("Funding", amount.Format(fund, 6)+" wUSDT"))
			b.WriteString(line("Closing fee", amount.Format(fee, 6)+" wUSDT"))
			b.WriteString(line("Paid to wallet", amount.Format(pay, 6)+" wUSDT"))
		}
	}
	b.WriteString(line("Transaction", tx.Hash.Hex()))
	return &closeOut{data: data, text: b.String()}, nil
}

func maxAgeFor(env *futuresEnv) int64 { return env.MaxAge }

func signed(v *big.Int) string {
	s := amount.Format(v, 6)
	if v.Sign() > 0 {
		return "+" + s
	}
	return s
}

func futCloseAllCmd(ctx context.Context, x *Ctx) (*Result, error) {
	env, err := x.futures(ctx, true)
	if err != nil {
		return nil, err
	}
	me, err := x.Address()
	if err != nil {
		return nil, err
	}
	ps, err := x.positions(ctx, env, me, true)
	if err != nil {
		return nil, err
	}
	var filter *dex.FuturesMarket
	if x.P.Str("market") != "" {
		if filter, err = resolveFutures(x.P.Str("market"), env); err != nil {
			return nil, err
		}
	}
	var results []map[string]any
	var b strings.Builder
	closed, failed := 0, 0
	for _, p := range ps {
		if filter != nil && p.Symbol != filter.Symbol {
			continue
		}
		out, err := x.closeOne(ctx, env, p, 10_000)
		if err != nil {
			e := errs.As(err)
			failed++
			results = append(results, map[string]any{"position_id": p.ID, "ok": false, "error": e})
			fmt.Fprintf(&b, "Position #%d (%s): NOT closed — %s\n", p.ID, p.Symbol, e.Message)
			continue
		}
		closed++
		out.data["ok"] = true
		results = append(results, out.data)
		b.WriteString(out.text)
	}
	if closed+failed == 0 {
		b.WriteString("No open positions to close.\n")
	} else {
		fmt.Fprintf(&b, "\nClosed %d position(s)%s.\n", closed, map[bool]string{true: fmt.Sprintf(", %d failed", failed), false: ""}[failed > 0])
	}
	res := &Result{Data: map[string]any{"closed": closed, "failed": failed, "results": results}, Text: b.String()}
	if failed > 0 && closed == 0 {
		return res, errs.Newf(errs.TxReverted, "None of the %d positions could be closed.", failed)
	}
	return res, nil
}

func futSetTPSLCmd(ctx context.Context, x *Ctx) (*Result, error) {
	id, err := parseID(x.P, "position")
	if err != nil {
		return nil, err
	}
	if !x.P.Has("take_profit") && !x.P.Has("stop_loss") {
		return nil, errs.New(errs.InvalidInput, "Give --take-profit and/or --stop-loss (a price, or none to remove).")
	}
	env, err := x.futures(ctx, true)
	if err != nil {
		return nil, err
	}
	me, err := x.Address()
	if err != nil {
		return nil, err
	}
	p, err := x.findPosition(ctx, env, me, id)
	if err != nil {
		return nil, err
	}
	if !p.Open {
		return nil, errs.Newf(errs.AlreadyClosed, "Position #%d is already closed.", p.ID)
	}
	if p.Router == (common.Address{}) {
		return nil, errs.Newf(errs.InvalidOrder, "Position #%d was opened before take profit / stop loss existed and cannot carry them.", p.ID)
	}
	tp, sl := p.TPE18, p.SLE18
	if x.P.Has("take_profit") {
		if tp, _, err = optPrice(x.P, "take_profit"); err != nil {
			return nil, err
		}
	}
	if x.P.Has("stop_loss") {
		if sl, _, err = optPrice(x.P, "stop_loss"); err != nil {
			return nil, err
		}
	}
	if tp != nil && tp.Sign() == 0 {
		tp = nil
	}
	if sl != nil && sl.Sign() == 0 {
		sl = nil
	}
	last := 0.0
	if mk, err := x.DEX().Marks(ctx, []string{p.Symbol}); err == nil {
		if v, ok := mk[p.Symbol]; ok {
			last = futures.FloatOrZero(v.Last)
			if last == 0 {
				last = futures.FloatOrZero(v.Fair)
			}
		}
	}
	if last > 0 {
		if err := futures.TriggerProblems(p.Long, last, amount.ToFloat(p.LiqE18, 18), ratOrNil(tp), ratOrNil(sl), false); err != nil {
			return nil, err
		}
	}
	tx, err := x.Send(ctx, chain.TxRequest{To: p.Router, Data: chain.Pack(chain.TriggersABI, "setTriggers", new(big.Int).SetUint64(p.ID), zeroIfNil(tp), zeroIfNil(sl)), Label: fmt.Sprintf("set TP/SL of position #%d", p.ID)})
	if err != nil {
		return nil, err
	}
	text := fmt.Sprintf("Position #%d (%s %s): take profit %s · stop loss %s\n", p.ID, strings.ToUpper(p.Side), p.Symbol, priceOrNone(tp), priceOrNone(sl)) +
		line("Transaction", tx.Hash.Hex()) + "  The keeper closes the whole position at the market price within seconds when the last price reaches one of them.\n"
	return &Result{Data: map[string]any{"position_id": p.ID, "take_profit": optE18(tp), "stop_loss": optE18(sl), "tx": tx.Hash.Hex()}, Text: text}, nil
}

func optE18(v *big.Int) any {
	if v == nil || v.Sign() == 0 {
		return nil
	}
	return amount.Format(v, 18)
}

func futPositionsCmd(ctx context.Context, x *Ctx) (*Result, error) {
	env, err := x.futures(ctx, false)
	if err != nil {
		return nil, err
	}
	me, err := x.Address()
	if err != nil {
		return nil, err
	}
	ps, err := x.positions(ctx, env, me, true)
	if err != nil {
		return nil, err
	}
	if s := x.P.Str("market"); s != "" {
		m, err := resolveFutures(s, env)
		if err != nil {
			return nil, err
		}
		var keep []*Position
		for _, p := range ps {
			if p.Symbol == m.Symbol {
				keep = append(keep, p)
			}
		}
		ps = keep
	}
	x.enrich(ctx, env, ps)
	return &Result{Data: map[string]any{"count": len(ps), "positions": nonNil(ps)}, Text: positionsText(ps)}, nil
}

func nonNil[T any](s []T) []T {
	if s == nil {
		return []T{}
	}
	return s
}

func positionsText(ps []*Position) string {
	if len(ps) == 0 {
		return "No open positions.\n"
	}
	var b strings.Builder
	for _, p := range ps {
		fmt.Fprintf(&b, "#%d  %s %s %dx  (isolated)\n", p.ID, strings.ToUpper(p.Side), p.Symbol, p.Leverage)
		b.WriteString(line("Margin / size", p.Margin+" wUSDT / "+p.Notional+" wUSDT ≈ "+trimNum(p.Size, 8)+" "+strings.TrimSuffix(p.Symbol, "_USDT")))
		cur := "—"
		if p.Last != nil {
			cur = amount.Price(*p.Last)
		}
		b.WriteString(line("Entry / last", amount.PriceE18(p.EntryE18)+" / "+cur))
		if p.LiqE18 != nil {
			b.WriteString(line("Liquidation", amount.PriceE18(p.LiqE18)))
		}
		if p.PnL != nil {
			roe := ""
			if p.ROE != nil {
				roe = " (" + *p.ROE + "% on margin)"
			}
			b.WriteString(line("PnL", *p.PnL+" wUSDT"+roe))
			b.WriteString(line("If closed now", "receive ≈ "+*p.PayoutNow+" wUSDT (after "+*p.CloseFee+" fee and "+*p.Funding+" funding)"))
		}
		b.WriteString(line("TP / SL", deref(p.TakeProfit, "none")+" / "+deref(p.StopLoss, "none")))
		if !p.Partial {
			b.WriteString(line("Note", "previous market contract: closes whole only"))
		}
		b.WriteString("\n")
	}
	return b.String()
}

func deref(p *string, d string) string {
	if p == nil {
		return d
	}
	return trimNum(*p, 8)
}

// trimNum shortens a decimal string to n decimals for display.
func trimNum(s string, n int) string {
	whole, frac, ok := strings.Cut(s, ".")
	if !ok || len(frac) <= n {
		return s
	}
	frac = strings.TrimRight(frac[:n], "0")
	if frac == "" {
		return whole
	}
	return whole + "." + frac
}

func futLimitCmd(ctx context.Context, x *Ctx) (*Result, error) {
	long, err := parseSide(x.P.Str("side"))
	if err != nil {
		return nil, err
	}
	env, err := x.futures(ctx, true)
	if err != nil {
		return nil, err
	}
	if env.API.LimitRouter == nil || *env.API.LimitRouter == "" {
		return nil, errs.New(errs.MarketPaused, "Limit orders are not available on the exchange right now.")
	}
	m, err := resolveFutures(x.P.Str("market"), env)
	if err != nil {
		return nil, err
	}
	if m.CloseOnly {
		return nil, errs.Newf(errs.MarketCloseOnly, "New positions are paused on %s (its last and mark prices are too far apart).", m.Symbol)
	}
	priceS, err := x.P.Need("price", "the limit price")
	if err != nil {
		return nil, err
	}
	limitE18, err := futures.PriceToE18(priceS)
	if err != nil {
		return nil, err
	}
	limitF := amount.ToFloat(limitE18, 18)
	if err := futures.LimitProblem(long, limitF, lastPrice(m)); err != nil {
		return nil, err
	}
	s, err := x.size(env, m, long, limitF, true)
	if err != nil {
		return nil, err
	}
	expiry, err := futures.ParseExpiry(x.P.Str("expires"))
	if err != nil {
		return nil, err
	}
	me, err := x.Address()
	if err != nil {
		return nil, err
	}
	c, err := x.Chain(ctx)
	if err != nil {
		return nil, err
	}
	if v, err := c.Read(ctx, chain.LimitABI, env.Limit, "openOrderCount", me); err == nil && v[0].(*big.Int).Int64() >= 25 {
		return nil, errs.New(errs.OrderLimitReached, "You already have 25 open limit orders, the maximum.").WithHint("Cancel one first: `elyon futures orders`, then `elyon futures cancel <id>`.")
	}
	if err := x.requireWUSDT(ctx, env, s.Cost); err != nil {
		return nil, errs.As(err).WithHint("A limit order takes nothing now, but the wallet must hold its full cost (margin + fee) until it fills.")
	}
	// The approval must cover every open order of the wallet, since each takes its own cost when it fills.
	need := new(big.Int).Set(s.Cost)
	if open, err := x.limitOrders(ctx, env, me, true); err == nil {
		for _, o := range open {
			if strings.HasPrefix(o.Status, "open") {
				need.Add(need, o.MaxCostRaw)
			}
		}
	}
	if err := x.EnsureAllowance(ctx, env.WUSDT, env.Limit, need, "wUSDT", x.wantUnlimited()); err != nil {
		return nil, err
	}
	expiresAt := x.Now().Add(expiry).Unix()
	params := struct {
		MarketId      *big.Int
		IsLong        bool
		Margin        *big.Int
		Leverage      uint32
		LimitPriceE18 *big.Int
		ExpiresAt     uint64
		TakeProfitE18 *big.Int
		StopLossE18   *big.Int
	}{big.NewInt(m.ID), long, s.Margin, uint32(s.Leverage), limitE18, uint64(expiresAt), zeroIfNil(s.TP), zeroIfNil(s.SL)}
	tx, err := x.Send(ctx, chain.TxRequest{To: env.Limit, Data: chain.Pack(chain.LimitABI, "placeLimit", params), Label: fmt.Sprintf("place limit %s %s %dx", sideWord(long), m.Base, s.Leverage), Revert: chain.RevertContext{"symbol": "wUSDT"}})
	if err != nil {
		return nil, err
	}
	data := map[string]any{"market": m.Symbol, "side": sideWord(long), "limit_price": amount.Format(limitE18, 18), "margin": amount.Format(s.Margin, 6), "leverage": s.Leverage, "size_wusdt": amount.Format(s.Notional, 6), "max_cost": amount.Format(s.Cost, 6), "expires_at": time.Unix(expiresAt, 0).UTC(), "tx": tx.Hash.Hex(), "take_profit": optE18(s.TP), "stop_loss": optE18(s.SL)}
	var b strings.Builder
	if ev := findEvent(tx.Receipt, env.Limit, chain.LimitABI, "LimitPlaced"); ev != nil {
		oid := ev.topics[1].Big().Uint64()
		data["order_id"] = oid
		fmt.Fprintf(&b, "Limit order #%d placed: %s %s %dx at %s wUSDT or better\n", oid, strings.ToUpper(sideWord(long)), m.Base, s.Leverage, amount.PriceE18(limitE18))
	} else {
		fmt.Fprintf(&b, "Limit order placed: %s %s %dx at %s wUSDT or better\n", strings.ToUpper(sideWord(long)), m.Base, s.Leverage, amount.PriceE18(limitE18))
	}
	b.WriteString(line("Margin / size", amount.Format(s.Margin, 6)+" wUSDT / "+amount.Format(s.Notional, 6)+" wUSDT"))
	b.WriteString(line("Taken when filled", amount.Format(s.Cost, 6)+" wUSDT (margin + fee); nothing was taken now"))
	b.WriteString(line("Expires", time.Unix(expiresAt, 0).UTC().Format("2006-01-02 15:04 UTC")))
	b.WriteString(line("Take profit", priceOrNone(s.TP)))
	b.WriteString(line("Stop loss", priceOrNone(s.SL)))
	b.WriteString(line("Transaction", tx.Hash.Hex()))
	b.WriteString("  Keep the cost in the wallet until it fills; otherwise the order is closed without a fill.\n")
	return &Result{Data: data, Text: b.String()}, nil
}

func futOrdersCmd(ctx context.Context, x *Ctx) (*Result, error) {
	env, err := x.futures(ctx, false)
	if err != nil {
		return nil, err
	}
	me, err := x.Address()
	if err != nil {
		return nil, err
	}
	all, err := x.P.Bool("all")
	if err != nil {
		return nil, err
	}
	os, err := x.limitOrders(ctx, env, me, !all)
	if err != nil {
		return nil, err
	}
	return &Result{Data: map[string]any{"count": len(os), "orders": nonNil(os)}, Text: ordersText(os)}, nil
}

func ordersText(os []*LimitOrder) string {
	if len(os) == 0 {
		return "No open limit orders.\n"
	}
	var b strings.Builder
	for _, o := range os {
		fmt.Fprintf(&b, "Order #%d  %s %s %dx at %s  [%s]\n", o.ID, strings.ToUpper(o.Side), o.Symbol, o.Leverage, amount.Price(mustF(o.LimitPrice)), o.Status)
		b.WriteString(line("Margin / cost", o.Margin+" wUSDT / "+o.MaxCost+" wUSDT when filled"))
		b.WriteString(line("Expires", o.ExpiresAt.Format("2006-01-02 15:04 UTC")))
		b.WriteString(line("TP / SL", deref(o.TakeProfit, "none")+" / "+deref(o.StopLoss, "none")))
		if o.PositionID != nil {
			b.WriteString(line("Position", fmt.Sprintf("#%d", *o.PositionID)))
		}
	}
	return b.String()
}

func mustF(s string) float64 { f, _ := strconv.ParseFloat(s, 64); return f }

func futCancelCmd(ctx context.Context, x *Ctx) (*Result, error) {
	id, err := parseID(x.P, "order")
	if err != nil {
		return nil, err
	}
	env, err := x.futures(ctx, true)
	if err != nil {
		return nil, err
	}
	out, err := x.cancelOne(ctx, env, id)
	if err != nil {
		return nil, err
	}
	return &Result{Data: out.data, Text: out.text}, nil
}

func (x *Ctx) cancelOne(ctx context.Context, env *futuresEnv, id uint64) (*closeOut, error) {
	me, err := x.Address()
	if err != nil {
		return nil, err
	}
	c, err := x.Chain(ctx)
	if err != nil {
		return nil, err
	}
	vals, err := c.Read(ctx, chain.LimitABI, env.Limit, "limitOrder", new(big.Int).SetUint64(id))
	if err != nil {
		return nil, err
	}
	o, err := decodeLimitOrder(vals)
	if err != nil {
		return nil, errs.New(errs.RPCUnavailable, "Could not read the order.")
	}
	if o.Trader != me {
		return nil, errs.Newf(errs.NotFound, "Limit order #%d does not belong to this wallet (or does not exist).", id)
	}
	if o.Status != 1 {
		return nil, errs.Newf(errs.AlreadyClosed, "Limit order #%d is not open any more (%s).", id, orderStatus[o.Status])
	}
	tx, err := x.Send(ctx, chain.TxRequest{To: env.Limit, Data: chain.Pack(chain.LimitABI, "cancelLimit", new(big.Int).SetUint64(id)), Label: fmt.Sprintf("cancel limit order #%d", id)})
	if err != nil {
		return nil, err
	}
	return &closeOut{data: map[string]any{"order_id": id, "cancelled": true, "tx": tx.Hash.Hex()}, text: fmt.Sprintf("Cancelled limit order #%d. Nothing was taken from the wallet.\n", id) + line("Transaction", tx.Hash.Hex())}, nil
}

func futCancelAllCmd(ctx context.Context, x *Ctx) (*Result, error) {
	env, err := x.futures(ctx, true)
	if err != nil {
		return nil, err
	}
	me, err := x.Address()
	if err != nil {
		return nil, err
	}
	var filter *dex.FuturesMarket
	if x.P.Str("market") != "" {
		if filter, err = resolveFutures(x.P.Str("market"), env); err != nil {
			return nil, err
		}
	}
	os, err := x.limitOrders(ctx, env, me, true)
	if err != nil {
		return nil, err
	}
	var results []map[string]any
	var b strings.Builder
	done, failed := 0, 0
	for _, o := range os {
		if filter != nil && o.Symbol != filter.Symbol {
			continue
		}
		out, err := x.cancelOne(ctx, env, o.ID)
		if err != nil {
			e := errs.As(err)
			failed++
			results = append(results, map[string]any{"order_id": o.ID, "ok": false, "error": e})
			fmt.Fprintf(&b, "Order #%d: NOT cancelled — %s\n", o.ID, e.Message)
			continue
		}
		done++
		out.data["ok"] = true
		results = append(results, out.data)
		b.WriteString(out.text)
	}
	if done+failed == 0 {
		b.WriteString("No open limit orders to cancel.\n")
	}
	res := &Result{Data: map[string]any{"cancelled": done, "failed": failed, "results": results}, Text: b.String()}
	if failed > 0 && done == 0 {
		return res, errs.Newf(errs.TxReverted, "None of the %d orders could be cancelled.", failed)
	}
	return res, nil
}

func futHistoryCmd(ctx context.Context, x *Ctx) (*Result, error) {
	me, err := x.Address()
	if err != nil {
		return nil, err
	}
	limit, err := x.P.Int("limit", 20)
	if err != nil {
		return nil, err
	}
	ps, err := x.DEX().Positions(ctx, me.Hex())
	if err != nil {
		return nil, err
	}
	os, _ := x.DEX().Orders(ctx, me.Hex())
	var closed []dex.HistoryPosition
	for _, p := range ps {
		if p.Status != "open" {
			closed = append(closed, p)
		}
	}
	if limit > 0 && int(limit) < len(closed) {
		closed = closed[:limit]
	}
	var b strings.Builder
	if len(closed) == 0 {
		b.WriteString("No closed positions yet.\n")
	}
	for _, p := range closed {
		how := p.Status
		if p.ClosedBy != nil {
			how = "closed by " + strings.ReplaceAll(*p.ClosedBy, "_", " ")
		}
		pnl := "—"
		if p.PnL != nil {
			pnl = *p.PnL
		}
		pay := "—"
		if p.Payout != nil {
			pay = *p.Payout
		}
		exit := "—"
		if p.ExitPrice != nil {
			exit = amount.Price(mustF(*p.ExitPrice))
		}
		fmt.Fprintf(&b, "#%d %s %s %dx · margin %s · entry %s → exit %s · PnL %s · paid %s wUSDT · %s\n", p.ID, strings.ToUpper(sideWord(p.IsLong)), p.Symbol, p.Leverage, p.Margin, amount.Price(mustF(p.EntryPrice)), exit, pnl, pay, how)
	}
	var past []dex.HistoryOrder
	for _, o := range os {
		if o.Status != "open" && o.Status != "filling" {
			past = append(past, o)
		}
	}
	if len(past) > 0 {
		b.WriteString("\nPast limit orders:\n")
		for i, o := range past {
			if i == 10 {
				break
			}
			fmt.Fprintf(&b, "  #%d %s %s %dx at %s — %s\n", o.OrderID, strings.ToUpper(sideWord(o.IsLong)), o.Symbol, o.Leverage, amount.Price(mustF(o.LimitPrice)), o.Status)
		}
	}
	b.WriteString("\n(History is indexed by the DEX and may lag a few seconds behind the chain.)\n")
	return &Result{Data: map[string]any{"closed_positions": nonNil(closed), "past_orders": nonNil(past)}, Text: b.String()}, nil
}
