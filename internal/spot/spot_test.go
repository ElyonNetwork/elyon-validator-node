package spot

import (
	"math/big"
	"testing"

	"github.com/ethereum/go-ethereum/common"

	"github.com/elyon-chain/elyon-bot/internal/errs"
)

func bi(s string) *big.Int { v, _ := new(big.Int).SetString(s, 10); return v }

// Reference values computed independently in Python with the Uniswap V2 formulas and the SDK impact formula.
func TestQuoteMath(t *testing.T) {
	rIn, rOut := bi("1222510895836"), bi("17756911655931932187") // wUSDT / wBTC pool reserves
	if got := GetAmountOut(big.NewInt(1_000_000), rIn, rOut); got.String() != "14481364986883" {
		t.Fatalf("amountOut %s", got)
	}
	in, err := GetAmountIn(bi("100000000000000"), rIn, rOut)
	if err != nil || in.String() != "6905460" {
		t.Fatalf("amountIn %v %v", in, err)
	}
	// exact-out input really buys at least the requested output
	if out := GetAmountOut(in, rIn, rOut); out.Cmp(bi("100000000000000")) < 0 {
		t.Fatalf("exact-in of exact-out quote is short: %s", out)
	}
	if _, err := GetAmountIn(rOut, rIn, rOut); err == nil {
		t.Fatal("buying the whole pool accepted")
	}
	if PriceImpactBps([]Hop{{rIn, rOut}}, big.NewInt(1_000_000)) != 0 {
		t.Fatal("1 wUSDT should have no measurable impact")
	}
	if got := PriceImpactBps([]Hop{{rIn, rOut}}, bi("100000000000")); got != 756 {
		t.Fatalf("impact for 100k wUSDT %d", got)
	}
	// two hops BTC -> wUSDT -> ETH
	hops := []Hop{{rOut, rIn}, {bi("1164868733543"), bi("600565437325281189460")}}
	out, err := QuoteExactIn(bi("10000000000000000"), hops)
	if err != nil || out.String() != "352419773234852531" {
		t.Fatalf("two-hop out %v %v", out, err)
	}
	if got := PriceImpactBps(hops, bi("10000000000000000")); got != 11 {
		t.Fatalf("two-hop impact %d", got)
	}
	back, err := QuoteExactOut(out, hops)
	if err != nil || back.Cmp(bi("10000000000000000")) > 0 {
		t.Fatalf("exact-out round trip %v %v", back, err)
	}
}

func TestSlippage(t *testing.T) {
	if MinOut(big.NewInt(1_000_000), 50).String() != "995000" {
		t.Fatal("minOut")
	}
	if MaxIn(big.NewInt(1_000_000), 50).String() != "1005000" || MaxIn(big.NewInt(1_000_001), 50).String() != "1005002" {
		t.Fatal("maxIn must round up")
	}
	if !InSync(100.05, 100, 10) || InSync(100.2, 100, 10) || InSync(0, 100, 10) {
		t.Fatal("sync tolerance")
	}
	if p := MidPrice(bi("17756911655931932187"), bi("1222510895836"), 18, 6); p < 68840 || p > 68850 {
		t.Fatalf("mid price %v", p)
	}
}

func markets() []Market {
	return []Market{
		{Base: "BTC", Display: "wBTC", Name: "Bitcoin", Token: common.HexToAddress("0x674cAF9F5996F9A68875F5C385d81ECc5A501048")},
		{Base: "WBTC", Display: "wWBTC", Name: "Wrapped Bitcoin", Token: common.HexToAddress("0x1111111111111111111111111111111111111111")},
		{Base: "ETH", Display: "wETH", Name: "Ethereum", Token: common.HexToAddress("0x7490356Dd812263e5b27AFE831C89DFEDE3331F6")},
		{Base: "1INCH", Display: "w1INCH", Name: "1INCH", Token: common.HexToAddress("0x2222222222222222222222222222222222222222")},
	}
}

func TestResolve(t *testing.T) {
	ms := markets()
	for in, want := range map[string]string{"wBTC": "BTC", "BTC": "BTC", "btc": "BTC", "WBTC": "WBTC", "wWBTC": "WBTC", "eth": "ETH", "WETH": "ETH", "1inch": "1INCH", "0x7490356dd812263e5b27afe831c89dfede3331f6": "ETH"} {
		m, err := Resolve(in, ms)
		if err != nil || m.Base != want {
			t.Errorf("%q -> %v %v, want %s", in, m, err, want)
		}
	}
	if _, err := Resolve("wbtc", ms); !errs.Is(err, errs.AmbiguousMarket) {
		t.Errorf("wbtc must be ambiguous: %v", err)
	}
	for _, eln := range []string{"ELN", "weln", "0xD48412aCe1346EAC5E4D0c9e613DBb7C2d25c1EE"} {
		if _, err := Resolve(eln, ms); !errs.Is(err, errs.ElnNotTradable) {
			t.Errorf("%s must be refused: %v", eln, err)
		}
	}
	if _, err := Resolve("DOGE", ms); !errs.Is(err, errs.UnknownMarket) {
		t.Errorf("unknown market: %v", err)
	}
	if got := Search(ms, "bit"); len(got) != 2 {
		t.Errorf("search by name: %v", got)
	}
	if !IsWUSDT("wUSDT", common.Address{}) || !IsWUSDT("usdt", common.Address{}) || IsWUSDT("wBTC", common.Address{}) {
		t.Error("wUSDT detection")
	}
}

func TestPairFor(t *testing.T) {
	factory := common.HexToAddress("0xFe3E2B27C75250e14C22Bc581b74CB00055c48E5")
	wusdt := common.HexToAddress("0x3D768c1838188DcA395489ae5D6b2C897A936f61")
	cases := map[string]string{
		"0x674cAF9F5996F9A68875F5C385d81ECc5A501048": "0x7132e554CC57351F291f45A0C64bd6f918166C7a", // wBTC/wUSDT (live pool)
		"0x7490356Dd812263e5b27AFE831C89DFEDE3331F6": "0xb8aa42Adc3A343f3caCEc4905daC3e38383f72eE", // wETH/wUSDT
		"0xD48412aCe1346EAC5E4D0c9e613DBb7C2d25c1EE": "0xb54a7cd02688893bf07b8a5e1df61f6b9f1ee349", // retired ELN pool
	}
	for token, pool := range cases {
		if got := PairFor(factory, common.HexToAddress(token), wusdt); got != common.HexToAddress(pool) {
			t.Errorf("%s: %s want %s", token, got.Hex(), pool)
		}
		if PairFor(factory, wusdt, common.HexToAddress(token)) != common.HexToAddress(pool) {
			t.Errorf("order must not matter")
		}
	}
}
