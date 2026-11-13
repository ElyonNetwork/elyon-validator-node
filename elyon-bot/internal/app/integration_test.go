//go:build integration

// Read-only checks against ElyonChain mainnet and the live DEX API. They send no transaction.
// Run: go test -tags integration ./internal/app/ -run Integration -v
package app

import (
	"context"
	"math/big"
	"testing"
	"time"

	"github.com/ethereum/go-ethereum/common"

	"github.com/elyon-chain/elyon-bot/internal/chain"
	"github.com/elyon-chain/elyon-bot/internal/config"
	"github.com/elyon-chain/elyon-bot/internal/spot"
)

// A public address with a known history on the DEX (the operator's test wallet).
var knownWallet = common.HexToAddress("0x0E0bB1BDEc7248eBac6eFBE624ceAEd86bda3e27")

func testCtx(t *testing.T) (*Ctx, context.Context) {
	t.Helper()
	a := New(t.TempDir(), config.Default(), ModeCLI)
	return &Ctx{App: a, Cmd: &Command{Name: "test", ReadOnly: true}, P: Params{}, res: &Result{}}, context.Background()
}

func TestIntegrationChainAndContracts(t *testing.T) {
	x, ctx := testCtx(t)
	c, err := x.Chain(ctx)
	if err != nil {
		t.Fatal(err)
	}
	if c.ChainID.Int64() != config.ChainID {
		t.Fatalf("chain id %s", c.ChainID)
	}
	k := x.Cfg.Contracts
	weth, err := c.Read(ctx, chain.RouterABI, config.Addr(k.Router), "WETH")
	if err != nil || weth[0].(common.Address) != config.Addr(k.WELN) {
		t.Fatalf("router WETH %v %v", weth, err)
	}
	fac, err := c.Read(ctx, chain.RouterABI, config.Addr(k.Router), "factory")
	if err != nil || fac[0].(common.Address) != config.Addr(k.Factory) {
		t.Fatalf("router factory %v %v", fac, err)
	}
	for _, router := range []string{k.PerpTriggers, k.PerpLimitRouter} {
		perp, err := c.Read(ctx, chain.TriggersABI, config.Addr(router), "perp")
		if err != nil || perp[0].(common.Address) != config.Addr(k.PerpMarket) {
			t.Fatalf("%s.perp() = %v %v", router, perp, err)
		}
	}
	q, err := c.Read(ctx, chain.PerpABI, config.Addr(k.PerpMarket), "quote")
	if err != nil || q[0].(common.Address) != config.Addr(k.WUSDT) {
		t.Fatalf("market quote token %v %v", q, err)
	}
}

func TestIntegrationFuturesMarketsAndQuote(t *testing.T) {
	x, ctx := testCtx(t)
	env, err := x.futures(ctx, true)
	if err != nil {
		t.Fatal(err)
	}
	if len(env.API.Markets) < 500 {
		t.Fatalf("only %d futures markets", len(env.API.Markets))
	}
	m, err := resolveFutures("btc-usdt", env)
	if err != nil || m.Symbol != "BTC_USDT" || m.ID != 0 {
		t.Fatalf("BTC market %+v %v", m, err)
	}
	q, qt, err := x.signedQuote(ctx, m.Symbol, env.Market, m.ID, env.MaxAge)
	if err != nil {
		t.Fatalf("signed quote: %v", err)
	}
	if q.Price <= 0 || qt.PriceE18.Sign() <= 0 || len(qt.Signature) != 65 {
		t.Fatalf("quote %+v", q)
	}
	t.Logf("BTC last %.2f, quote verified (feeder registered on-chain), age %ds", q.Price, time.Now().Unix()-q.Timestamp)
}

func TestIntegrationSpotMarketsAndPools(t *testing.T) {
	x, ctx := testCtx(t)
	ms, err := x.spotMarkets(ctx)
	if err != nil {
		t.Fatal(err)
	}
	if len(ms) < 1000 {
		t.Fatalf("only %d spot markets", len(ms))
	}
	m, err := spot.Resolve("BTC", ms)
	if err != nil || m.Display != "wBTC" || m.New {
		t.Fatalf("BTC %+v %v", m, err)
	}
	st, err := x.readPool(ctx, m)
	if err != nil {
		t.Fatal(err)
	}
	if st.Mid <= 0 || st.Reference <= 0 || st.ReserveBase.Sign() <= 0 {
		t.Fatalf("pool state %+v", st)
	}
	o, err := x.planSpot(ctx, "wUSDT", "BTC", "1", false)
	if err != nil {
		t.Fatal(err)
	}
	if err := o.quote([]*poolState{st}); err != nil || o.AmountOut.Sign() <= 0 || o.ImpactBps > 10 {
		t.Fatalf("quote %+v %v", o, err)
	}
	if _, err := x.planSpot(ctx, "wUSDT", "ELN", "1", false); err == nil {
		t.Fatal("ELN trade planned")
	}
	t.Logf("wBTC pool %.2f vs global %.2f (in sync: %v); 1 wUSDT buys %s wei of wBTC", st.Mid, st.Reference, st.InSync, o.AmountOut)
}

func TestIntegrationKnownWalletReads(t *testing.T) {
	x, ctx := testCtx(t)
	assets := x.knownAssets(ctx)
	if len(assets) < 1300 {
		t.Fatalf("only %d assets", len(assets))
	}
	hs, err := x.balances(ctx, knownWallet, assets)
	if err != nil {
		t.Fatal(err)
	}
	var wusdt, eln string
	for _, h := range hs {
		switch h.Kind {
		case "wusdt":
			wusdt = h.Balance
		case "native":
			eln = h.Balance
		}
	}
	if wusdt == "" || wusdt == "0" || eln == "" {
		t.Fatalf("known wallet balances: wUSDT %q ELN %q", wusdt, eln)
	}
	env, err := x.futures(ctx, false)
	if err != nil {
		t.Fatal(err)
	}
	ps, err := x.positions(ctx, env, knownWallet, false)
	if err != nil || len(ps) == 0 {
		t.Fatalf("positions of the known wallet: %d %v", len(ps), err)
	}
	os, err := x.limitOrders(ctx, env, knownWallet, false)
	if err != nil || len(os) == 0 || os[0].Status == "" || os[0].Symbol != "BTC_USDT" {
		t.Fatalf("limit orders of the known wallet: %+v %v", os, err)
	}
	sale, err := x.gasSale(ctx, knownWallet)
	if err != nil || sale.Price.Cmp(big.NewInt(0)) <= 0 {
		t.Fatalf("gas sale %+v %v", sale, err)
	}
	t.Logf("known wallet: %s wUSDT, %s ELN, %d positions (history), %d limit orders; gas sale %s wUSDT/ELN", wusdt, eln, len(ps), len(os), sale.Price)
}
