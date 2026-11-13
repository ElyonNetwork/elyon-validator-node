package app

import (
	"context"
	"fmt"
	"math/big"
	"reflect"
	"sort"
	"strings"
	"sync"
	"time"

	"github.com/ethereum/go-ethereum/common"

	"github.com/elyon-chain/elyon-bot/internal/amount"
	"github.com/elyon-chain/elyon-bot/internal/chain"
	"github.com/elyon-chain/elyon-bot/internal/config"
	"github.com/elyon-chain/elyon-bot/internal/dex"
	"github.com/elyon-chain/elyon-bot/internal/errs"
	"github.com/elyon-chain/elyon-bot/internal/futures"
)

// futuresEnv is the futures deployment, verified against the contracts this build trusts.
type futuresEnv struct {
	API      *dex.FuturesMarkets
	Market   common.Address
	Triggers common.Address
	Limit    common.Address
	WUSDT    common.Address
	MaxAge   int64
	MaxNotl  *big.Int
	byID     map[int64]*dex.FuturesMarket
}

// futures loads the market list and checks that the exchange still uses the pinned contracts. With strict=false
// (read-only listing) a mismatch is only a warning.
func (x *Ctx) futures(ctx context.Context, strict bool) (*futuresEnv, error) {
	api, err := x.DEX().FuturesMarkets(ctx)
	if err != nil {
		return nil, err
	}
	k := x.Cfg.Contracts
	env := &futuresEnv{API: api, Market: config.Addr(k.PerpMarket), Triggers: config.Addr(k.PerpTriggers), Limit: config.Addr(k.PerpLimitRouter), WUSDT: config.Addr(k.WUSDT), MaxAge: api.MaxQuoteAgeSeconds, byID: map[int64]*dex.FuturesMarket{}}
	if env.MaxAge <= 0 || env.MaxAge > 45 {
		env.MaxAge = 20
	}
	env.MaxNotl = big.NewInt(20_000_000_000)
	if v, err := amount.ParsePositive(api.MaxNotionalUsdt, 6); err == nil {
		env.MaxNotl = v
	}
	for i := range api.Markets {
		env.byID[api.Markets[i].ID] = &api.Markets[i]
	}
	var mismatch []string
	if !sameAddr(api.Contract, env.Market) {
		mismatch = append(mismatch, "market "+api.Contract)
	}
	if !sameAddr(api.Triggers, env.Triggers) {
		mismatch = append(mismatch, "TP/SL router "+api.Triggers)
	}
	if api.LimitRouter != nil && *api.LimitRouter != "" && !sameAddr(*api.LimitRouter, env.Limit) {
		mismatch = append(mismatch, "limit router "+*api.LimitRouter)
	}
	if !sameAddr(api.Quote, env.WUSDT) {
		mismatch = append(mismatch, "margin token "+api.Quote)
	}
	if len(mismatch) > 0 {
		e := errs.Newf(errs.ContractMismatch, "The exchange now uses futures contracts this elyon-bot does not know (%s).", strings.Join(mismatch, ", ")).
			WithHint("For your safety it will not approve or call unknown contracts. Update elyon-bot (or, if you verified them, set them in config.json).")
		if strict {
			return nil, e
		}
		x.Warn(e.Error())
	}
	return env, nil
}

func sameAddr(s string, a common.Address) bool {
	return common.IsHexAddress(s) && common.HexToAddress(s) == a
}

// resolveFutures finds a market from "BTC", "btc", "BTC_USDT", "BTCUSDT", "btc-usdt", "BTC/USDT" or "wBTC".
func resolveFutures(input string, env *futuresEnv) (*dex.FuturesMarket, error) {
	in := strings.ToUpper(strings.TrimSpace(input))
	if in == "" {
		return nil, errs.New(errs.InvalidInput, "Name the futures market, for example BTC.")
	}
	norm := strings.NewReplacer("/", "", "-", "", "_", "", " ", "").Replace(in)
	norm = strings.TrimSuffix(norm, "USDT")
	ms := env.API.Markets
	find := func(base string) *dex.FuturesMarket {
		for i := range ms {
			if ms[i].Symbol == base+"_USDT" || ms[i].Base == base {
				return &ms[i]
			}
		}
		return nil
	}
	if m := find(norm); m != nil {
		return m, nil
	}
	if strings.HasPrefix(norm, "W") {
		if m := find(norm[1:]); m != nil {
			return m, nil
		}
	}
	var sug []string
	for _, m := range ms {
		if strings.HasPrefix(m.Base, norm) || (m.Name != nil && strings.Contains(strings.ToUpper(*m.Name), norm)) {
			sug = append(sug, m.Base)
			if len(sug) == 6 {
				break
			}
		}
	}
	e := errs.Newf(errs.UnknownMarket, "There is no futures market %q.", input)
	if len(sug) > 0 {
		e.WithHint("Did you mean " + strings.Join(sug, ", ") + "?")
	} else {
		e.WithHint("Search with `elyon futures markets --search <text>`.")
	}
	return nil, e
}

func lastPrice(m *dex.FuturesMarket) float64 {
	if p := futures.FloatOrZero(m.Last); p > 0 {
		return p
	}
	return futures.FloatOrZero(m.Fair)
}

func marketTitle(m *dex.FuturesMarket) string {
	if m.Name != nil && *m.Name != "" {
		return fmt.Sprintf("%s (%s) perpetual", *m.Name, m.Base)
	}
	return m.Base + "/wUSDT perpetual"
}

// quoteTuple is the Solidity Quote struct.
type quoteTuple struct {
	MarketId  *big.Int
	PriceE18  *big.Int
	Timestamp uint64
	Signature []byte
}

// signedQuote fetches and verifies a fresh signed price for a market contract: contract, market, symbol, age
// (like the website) and, in addition, that the signer is a registered feeder of that contract on-chain.
func (x *Ctx) signedQuote(ctx context.Context, symbol string, contract common.Address, marketID int64, maxAge int64) (*dex.SignedQuote, quoteTuple, error) {
	q, err := x.DEX().Quote(ctx, symbol, contract.Hex())
	if err != nil {
		return nil, quoteTuple{}, err
	}
	if err := futures.ValidateQuoteFields(q.Contract, q.MarketID, q.Symbol, q.Timestamp, futures.QuoteCheck{Contract: contract, MarketID: marketID, Symbol: symbol, MaxAgeSec: maxAge, Now: x.Now()}); err != nil {
		return nil, quoteTuple{}, err
	}
	price, ok := q.PriceE18Int()
	if !ok || price.Sign() <= 0 {
		return nil, quoteTuple{}, errs.New(errs.QuoteUnavailable, "The price quote was malformed.").WithHint("Retry.")
	}
	signer, err := futures.RecoverSigner(config.ChainID, contract, q.MarketID, price, q.Timestamp, q.Signature)
	if err != nil {
		return nil, quoteTuple{}, errs.New(errs.QuoteUnavailable, "The price quote signature is malformed.").WithHint("Retry.")
	}
	if err := x.checkFeeder(ctx, contract, signer); err != nil {
		return nil, quoteTuple{}, err
	}
	sig := common.FromHex(q.Signature)
	return q, quoteTuple{MarketId: big.NewInt(q.MarketID), PriceE18: price, Timestamp: uint64(q.Timestamp), Signature: sig}, nil
}

func (x *Ctx) checkFeeder(ctx context.Context, contract, signer common.Address) error {
	key := common.BytesToAddress(append(contract.Bytes()[:10], signer.Bytes()[:10]...))
	x.mu.Lock()
	ok := x.feeders[key]
	x.mu.Unlock()
	if ok {
		return nil
	}
	c, err := x.Chain(ctx)
	if err != nil {
		return err
	}
	v, err := c.Read(ctx, chain.PerpABI, contract, "isFeeder", signer)
	if err != nil {
		return err
	}
	if b, _ := v[0].(bool); !b {
		return errs.Newf(errs.QuoteUnavailable, "The price quote was signed by %s, which is not a price feeder of the futures contract. Refusing it.", signer.Hex())
	}
	x.mu.Lock()
	x.feeders[key] = true
	x.mu.Unlock()
	return nil
}

// ---------------------------------------------------------------- positions on-chain

// Position is an open (or just read) futures position.
type Position struct {
	ID         uint64         `json:"id"`
	Contract   common.Address `json:"contract"`
	Router     common.Address `json:"router"`
	Holder     string         `json:"held_by"` // tp-sl-router, limit-router, legacy-router, direct
	Symbol     string         `json:"market"`
	MarketID   int64          `json:"market_id"`
	Long       bool           `json:"long"`
	Side       string         `json:"side"`
	Open       bool           `json:"open"`
	OpenedAt   time.Time      `json:"opened_at"`
	Leverage   int64          `json:"leverage"`
	MarginRaw  *big.Int       `json:"-"`
	NotionRaw  *big.Int       `json:"-"`
	EntryE18   *big.Int       `json:"-"`
	SizeE18    *big.Int       `json:"-"`
	LiqE18     *big.Int       `json:"-"`
	TPE18      *big.Int       `json:"-"`
	SLE18      *big.Int       `json:"-"`
	FeePpm     int64          `json:"fee_ppm"`
	Partial    bool           `json:"partial_close_available"`
	Margin     string         `json:"margin"`
	Notional   string         `json:"size_wusdt"`
	Size       string         `json:"size_base"`
	Entry      string         `json:"entry_price"`
	Liq        string         `json:"liquidation_price"`
	TakeProfit *string        `json:"take_profit"`
	StopLoss   *string        `json:"stop_loss"`
	// live values (filled by enrich)
	Last       *float64 `json:"last_price,omitempty"`
	Mark       *float64 `json:"mark_price,omitempty"`
	PnL        *string  `json:"unrealized_pnl,omitempty"`
	ROE        *string  `json:"roe_pct,omitempty"`
	Funding    *string  `json:"funding_owed,omitempty"`
	CloseFee   *string  `json:"close_fee,omitempty"`
	PayoutNow  *string  `json:"payout_if_closed_now,omitempty"`
	Liquidable bool     `json:"liquidatable,omitempty"`
}

type holder struct {
	router, market common.Address
	kind           string
}

// holders lists where positions of this wallet can live: the TP/SL router, the limit router (current market),
// the legacy router (previous market) and the markets themselves (positions opened directly, before TP/SL).
func (x *Ctx) holders(ctx context.Context) []holder {
	k := x.Cfg.Contracts
	hs := []holder{{config.Addr(k.PerpTriggers), config.Addr(k.PerpMarket), "tp-sl-router"}, {config.Addr(k.PerpLimitRouter), config.Addr(k.PerpMarket), "limit-router"}}
	for i, t := range k.LegacyTriggers {
		if i < len(k.LegacyPerpMarket) {
			hs = append(hs, holder{config.Addr(t), config.Addr(k.LegacyPerpMarket[i]), "legacy-router"})
		}
	}
	hs = append(hs, holder{common.Address{}, config.Addr(k.PerpMarket), "direct"})
	for _, m := range k.LegacyPerpMarket {
		hs = append(hs, holder{common.Address{}, config.Addr(m), "direct"})
	}
	return hs
}

// positions reads the wallet's positions from the chain (open ones only unless all=true).
func (x *Ctx) positions(ctx context.Context, env *futuresEnv, me common.Address, onlyOpen bool) ([]*Position, error) {
	c, err := x.Chain(ctx)
	if err != nil {
		return nil, err
	}
	hs := x.holders(ctx)
	var calls []chain.Call
	for _, h := range hs {
		target := h.router
		if h.kind == "direct" {
			target = h.market
		}
		calls = append(calls, chain.Call{To: target, Data: chain.Pack(chain.TriggersABI, "positionsOf", me)})
	}
	type cand struct {
		id *big.Int
		h  holder
	}
	var cands []cand
	for i, r := range c.BatchCall(ctx, calls) {
		if r.Err != nil {
			continue
		}
		vals, err := chain.TriggersABI.Unpack("positionsOf", r.Data)
		if err != nil {
			continue
		}
		for _, id := range vals[0].([]*big.Int) {
			key := hs[i].market.Hex() + ":" + id.String()
			closedMu.Lock()
			closed := closedCache[key]
			closedMu.Unlock()
			if onlyOpen && closed {
				continue
			}
			cands = append(cands, cand{id, hs[i]})
		}
	}
	if len(cands) == 0 {
		return nil, nil
	}
	calls = calls[:0]
	for _, cd := range cands {
		calls = append(calls, chain.Call{To: cd.h.market, Data: chain.Pack(chain.PerpABI, "positions", cd.id)})
	}
	posRes := c.BatchCall(ctx, calls)
	var out []*Position
	var openIdx []int
	for i, r := range posRes {
		if r.Err != nil {
			continue
		}
		v, err := chain.PerpABI.Unpack("positions", r.Data)
		if err != nil {
			continue
		}
		owner := v[0].(common.Address)
		cd := cands[i]
		if cd.h.kind == "direct" && owner != me {
			continue
		}
		p := &Position{ID: cd.id.Uint64(), Contract: cd.h.market, Router: cd.h.router, Holder: cd.h.kind, MarketID: int64(v[1].(uint32)), Long: v[2].(bool), Open: v[3].(bool),
			OpenedAt: time.Unix(int64(v[4].(uint64)), 0).UTC(), MarginRaw: v[5].(*big.Int), NotionRaw: v[6].(*big.Int), EntryE18: v[7].(*big.Int), SizeE18: v[8].(*big.Int)}
		if !p.Open {
			closedMu.Lock()
			closedCache[cd.h.market.Hex()+":"+cd.id.String()] = true
			closedMu.Unlock()
			if onlyOpen {
				continue
			}
		}
		out = append(out, p)
		openIdx = append(openIdx, len(out)-1)
	}
	// Details: triggers (router positions), liquidation price, fee, market symbol.
	calls = calls[:0]
	type ref struct {
		p    *Position
		what string
	}
	var refs []ref
	for _, p := range out {
		if !p.Open {
			continue
		}
		if p.Router != (common.Address{}) {
			calls = append(calls, chain.Call{To: p.Router, Data: chain.Pack(chain.TriggersABI, "orders", new(big.Int).SetUint64(p.ID))})
			refs = append(refs, ref{p, "orders"})
		}
		calls = append(calls, chain.Call{To: p.Contract, Data: chain.Pack(chain.PerpABI, "liquidationPrice", new(big.Int).SetUint64(p.ID))})
		refs = append(refs, ref{p, "liq"})
		calls = append(calls, chain.Call{To: p.Contract, Data: chain.Pack(chain.PerpABI, "positionFeePpm", new(big.Int).SetUint64(p.ID))})
		refs = append(refs, ref{p, "fee"})
		if p.Contract != env.Market {
			calls = append(calls, chain.Call{To: p.Contract, Data: chain.Pack(chain.PerpABI, "markets", big.NewInt(p.MarketID))})
			refs = append(refs, ref{p, "market"})
		}
	}
	var mine []*Position
	notMine := map[*Position]bool{}
	for i, r := range c.BatchCall(ctx, calls) {
		rf := refs[i]
		if r.Err != nil {
			continue
		}
		switch rf.what {
		case "orders":
			if v, err := chain.TriggersABI.Unpack("orders", r.Data); err == nil {
				if v[0].(common.Address) != me {
					notMine[rf.p] = true
				}
				rf.p.TPE18, rf.p.SLE18 = v[1].(*big.Int), v[2].(*big.Int)
			}
		case "liq":
			if v, err := chain.PerpABI.Unpack("liquidationPrice", r.Data); err == nil {
				rf.p.LiqE18 = v[0].(*big.Int)
			}
		case "fee":
			if v, err := chain.PerpABI.Unpack("positionFeePpm", r.Data); err == nil {
				rf.p.FeePpm = int64(v[0].(uint32))
			}
		case "market":
			if v, err := chain.PerpABI.Unpack("markets", r.Data); err == nil {
				rf.p.Symbol = v[5].(string)
			}
		}
	}
	_ = openIdx
	for _, p := range out {
		if notMine[p] {
			continue
		}
		if p.Symbol == "" {
			if m, ok := env.byID[p.MarketID]; ok && p.Contract == env.Market {
				p.Symbol = m.Symbol
			} else {
				p.Symbol = fmt.Sprintf("market #%d", p.MarketID)
			}
		}
		p.fill()
		mine = append(mine, p)
	}
	sort.Slice(mine, func(i, j int) bool { return mine[i].ID > mine[j].ID })
	return mine, nil
}

// closedCache remembers closed positions and finished orders (they never reopen) so long histories are not
// re-read on every call. It is guarded by closedMu.
var (
	closedMu    sync.Mutex
	closedCache = map[string]bool{}
)

func (p *Position) fill() {
	p.Side = map[bool]string{true: "long", false: "short"}[p.Long]
	if p.MarginRaw != nil && p.MarginRaw.Sign() > 0 {
		lev := new(big.Int).Add(p.NotionRaw, new(big.Int).Quo(p.MarginRaw, big.NewInt(2)))
		p.Leverage = lev.Quo(lev, p.MarginRaw).Int64()
	}
	p.Margin = amount.Format(p.MarginRaw, 6)
	p.Notional = amount.Format(p.NotionRaw, 6)
	p.Size = amount.Format(p.SizeE18, 18)
	p.Entry = amount.Format(p.EntryE18, 18)
	if p.LiqE18 != nil {
		p.Liq = amount.Format(p.LiqE18, 18)
	}
	if p.TPE18 != nil && p.TPE18.Sign() > 0 {
		s := amount.Format(p.TPE18, 18)
		p.TakeProfit = &s
	}
	if p.SLE18 != nil && p.SLE18.Sign() > 0 {
		s := amount.Format(p.SLE18, 18)
		p.StopLoss = &s
	}
	p.Partial = p.Router != (common.Address{}) && p.Holder != "legacy-router"
}

// enrich adds live prices and the exact settlement at the last price (previewClose on the contract).
func (x *Ctx) enrich(ctx context.Context, env *futuresEnv, ps []*Position) {
	if len(ps) == 0 {
		return
	}
	var syms []string
	seen := map[string]bool{}
	for _, p := range ps {
		if !seen[p.Symbol] && strings.HasSuffix(p.Symbol, "_USDT") {
			seen[p.Symbol] = true
			syms = append(syms, p.Symbol)
		}
	}
	marks, _ := x.DEX().Marks(ctx, syms)
	c, err := x.Chain(ctx)
	if err != nil {
		return
	}
	var calls []chain.Call
	var idx []*Position
	for _, p := range ps {
		mk, ok := marks[p.Symbol]
		if !ok {
			continue
		}
		p.Last, p.Mark = mk.Last, mk.Fair
		last := futures.FloatOrZero(mk.Last)
		if last <= 0 {
			last = futures.FloatOrZero(mk.Fair)
		}
		pe18, err := amount.FromFloat(last, 18)
		if err != nil || pe18.Sign() == 0 || !p.Open {
			continue
		}
		calls = append(calls, chain.Call{To: p.Contract, Data: chain.Pack(chain.PerpABI, "previewClose", new(big.Int).SetUint64(p.ID), pe18)})
		idx = append(idx, p)
	}
	for i, r := range c.BatchCall(ctx, calls) {
		if r.Err != nil {
			continue
		}
		v, err := chain.PerpABI.Unpack("previewClose", r.Data)
		if err != nil {
			continue
		}
		p := idx[i]
		pnl, fund, fee, pay := v[0].(*big.Int), v[1].(*big.Int), v[2].(*big.Int), v[3].(*big.Int)
		s1, s2, s3, s4 := amount.Format(pnl, 6), amount.Format(fund, 6), amount.Format(fee, 6), amount.Format(pay, 6)
		p.PnL, p.Funding, p.CloseFee, p.PayoutNow, p.Liquidable = &s1, &s2, &s3, &s4, v[4].(bool)
		if p.MarginRaw.Sign() > 0 {
			roe := new(big.Rat).SetFrac(new(big.Int).Mul(pnl, big.NewInt(100)), p.MarginRaw)
			f, _ := roe.Float64()
			r := fmt.Sprintf("%.2f", f)
			p.ROE = &r
		}
	}
}

// findPosition locates one position of the wallet by id (any holder).
func (x *Ctx) findPosition(ctx context.Context, env *futuresEnv, me common.Address, id uint64) (*Position, error) {
	c, err := x.Chain(ctx)
	if err != nil {
		return nil, err
	}
	hs := x.holders(ctx)
	bid := new(big.Int).SetUint64(id)
	var calls []chain.Call
	for _, h := range hs {
		if h.kind == "direct" {
			calls = append(calls, chain.Call{To: h.market, Data: chain.Pack(chain.PerpABI, "positions", bid)})
		} else {
			calls = append(calls, chain.Call{To: h.router, Data: chain.Pack(chain.TriggersABI, "orders", bid)})
		}
	}
	for i, r := range c.BatchCall(ctx, calls) {
		if r.Err != nil {
			continue
		}
		h := hs[i]
		mine := false
		if h.kind == "direct" {
			if v, err := chain.PerpABI.Unpack("positions", r.Data); err == nil && v[0].(common.Address) == me {
				mine = true
			}
		} else if v, err := chain.TriggersABI.Unpack("orders", r.Data); err == nil && v[0].(common.Address) == me {
			mine = true
		}
		if !mine {
			continue
		}
		ps, err := x.positionsByHolder(ctx, env, me, h, bid)
		if err != nil {
			return nil, err
		}
		return ps, nil
	}
	return nil, errs.Newf(errs.NotFound, "Position #%d does not belong to this wallet (or does not exist).", id).WithHint("List your positions with `elyon futures positions`.")
}

func (x *Ctx) positionsByHolder(ctx context.Context, env *futuresEnv, me common.Address, h holder, id *big.Int) (*Position, error) {
	c, err := x.Chain(ctx)
	if err != nil {
		return nil, err
	}
	v, err := c.Read(ctx, chain.PerpABI, h.market, "positions", id)
	if err != nil {
		return nil, err
	}
	p := &Position{ID: id.Uint64(), Contract: h.market, Router: h.router, Holder: h.kind, MarketID: int64(v[1].(uint32)), Long: v[2].(bool), Open: v[3].(bool),
		OpenedAt: time.Unix(int64(v[4].(uint64)), 0).UTC(), MarginRaw: v[5].(*big.Int), NotionRaw: v[6].(*big.Int), EntryE18: v[7].(*big.Int), SizeE18: v[8].(*big.Int)}
	if p.Router != (common.Address{}) {
		if o, err := c.Read(ctx, chain.TriggersABI, p.Router, "orders", id); err == nil {
			p.TPE18, p.SLE18 = o[1].(*big.Int), o[2].(*big.Int)
		}
	}
	if l, err := c.Read(ctx, chain.PerpABI, p.Contract, "liquidationPrice", id); err == nil {
		p.LiqE18 = l[0].(*big.Int)
	}
	if f, err := c.Read(ctx, chain.PerpABI, p.Contract, "positionFeePpm", id); err == nil {
		p.FeePpm = int64(f[0].(uint32))
	}
	if p.Contract == env.Market {
		if m, ok := env.byID[p.MarketID]; ok {
			p.Symbol = m.Symbol
		}
	} else if mv, err := c.Read(ctx, chain.PerpABI, p.Contract, "markets", big.NewInt(p.MarketID)); err == nil {
		p.Symbol = mv[5].(string)
	}
	p.fill()
	return p, nil
}

// LimitOrder is a limit order of the wallet.
type LimitOrder struct {
	ID         uint64    `json:"order_id"`
	Symbol     string    `json:"market"`
	MarketID   int64     `json:"market_id"`
	Long       bool      `json:"long"`
	Side       string    `json:"side"`
	Status     string    `json:"status"`
	Leverage   int64     `json:"leverage"`
	Margin     string    `json:"margin"`
	MaxCost    string    `json:"max_cost"`
	MaxCostRaw *big.Int  `json:"-"`
	LimitPrice string    `json:"limit_price"`
	ExpiresAt  time.Time `json:"expires_at"`
	PlacedAt   time.Time `json:"placed_at"`
	TakeProfit *string   `json:"take_profit"`
	StopLoss   *string   `json:"stop_loss"`
	PositionID *uint64   `json:"position_id,omitempty"`
}

var orderStatus = map[uint8]string{1: "open", 2: "filled", 3: "cancelled", 4: "closed without a fill"}

// limitOrders reads the wallet's limit orders from the chain (newest first).
func (x *Ctx) limitOrders(ctx context.Context, env *futuresEnv, me common.Address, onlyOpen bool) ([]*LimitOrder, error) {
	c, err := x.Chain(ctx)
	if err != nil {
		return nil, err
	}
	v, err := c.Read(ctx, chain.LimitABI, env.Limit, "limitOrdersOf", me)
	if err != nil {
		return nil, err
	}
	ids := v[0].([]*big.Int)
	var calls []chain.Call
	var keep []*big.Int
	for _, id := range ids {
		key := "order:" + id.String()
		closedMu.Lock()
		done := closedCache[key]
		closedMu.Unlock()
		if onlyOpen && done {
			continue
		}
		keep = append(keep, id)
		calls = append(calls, chain.Call{To: env.Limit, Data: chain.Pack(chain.LimitABI, "limitOrder", id)})
	}
	var out []*LimitOrder
	for i, r := range c.BatchCall(ctx, calls) {
		if r.Err != nil {
			continue
		}
		vals, err := chain.LimitABI.Unpack("limitOrder", r.Data)
		if err != nil {
			continue
		}
		o, err := decodeLimitOrder(vals)
		if err != nil {
			continue
		}
		if o.Trader != me {
			continue
		}
		if o.Status != 1 {
			closedMu.Lock()
			closedCache["order:"+keep[i].String()] = true
			closedMu.Unlock()
			if onlyOpen {
				continue
			}
		}
		lo := &LimitOrder{ID: keep[i].Uint64(), MarketID: int64(o.MarketId), Long: o.IsLong, Side: map[bool]string{true: "long", false: "short"}[o.IsLong], Status: orderStatus[o.Status], Leverage: int64(o.Leverage),
			Margin: amount.Format(o.Margin, 6), MaxCost: amount.Format(o.MaxCost, 6), MaxCostRaw: o.MaxCost, LimitPrice: amount.Format(o.LimitPriceE18, 18),
			ExpiresAt: time.Unix(int64(o.ExpiresAt), 0).UTC(), PlacedAt: time.Unix(int64(o.PlacedAt), 0).UTC()}
		if lo.Status == "open" && x.Now().After(lo.ExpiresAt) {
			lo.Status = "expired (waiting to be closed)"
		}
		if m, ok := env.byID[lo.MarketID]; ok {
			lo.Symbol = m.Symbol
		} else {
			lo.Symbol = fmt.Sprintf("market #%d", lo.MarketID)
		}
		if o.TakeProfitE18.Sign() > 0 {
			s := amount.Format(o.TakeProfitE18, 18)
			lo.TakeProfit = &s
		}
		if o.StopLossE18.Sign() > 0 {
			s := amount.Format(o.StopLossE18, 18)
			lo.StopLoss = &s
		}
		if o.Status == 2 {
			pid := o.PositionId.Uint64()
			lo.PositionID = &pid
		}
		out = append(out, lo)
	}
	sort.Slice(out, func(i, j int) bool { return out[i].ID > out[j].ID })
	return out, nil
}

// limitOrderT mirrors ElyonPerpLimitRouter.LimitOrder.
type limitOrderT struct {
	Trader        common.Address
	MarketId      uint32
	Leverage      uint32
	IsLong        bool
	Status        uint8
	Margin        *big.Int
	MaxCost       *big.Int
	LimitPriceE18 *big.Int
	ExpiresAt     uint64
	PlacedAt      uint64
	TakeProfitE18 *big.Int
	StopLossE18   *big.Int
	PositionId    *big.Int
}

// decodeLimitOrder reads the tuple returned by limitOrder(id) (an anonymous struct after Unpack).
func decodeLimitOrder(vals []any) (limitOrderT, error) {
	var o limitOrderT
	if len(vals) != 1 {
		return o, fmt.Errorf("unexpected limitOrder output")
	}
	rv := reflect.ValueOf(vals[0])
	if rv.Kind() != reflect.Struct {
		return o, fmt.Errorf("unexpected limitOrder output")
	}
	ov := reflect.ValueOf(&o).Elem()
	for i := 0; i < ov.NumField(); i++ {
		f := rv.FieldByName(ov.Type().Field(i).Name)
		if !f.IsValid() || !f.Type().AssignableTo(ov.Field(i).Type()) {
			return o, fmt.Errorf("limitOrder field %s missing", ov.Type().Field(i).Name)
		}
		ov.Field(i).Set(f)
	}
	return o, nil
}
