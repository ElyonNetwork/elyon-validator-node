package futures

import (
	"math"
	"math/big"
	"testing"
	"time"

	"github.com/ethereum/go-ethereum/common"

	"github.com/elyon-chain/elyon-bot/internal/errs"
)

// Vector produced with ethers.js exactly like the DEX quote signer (services/futures/src/run.ts signQuote).
func TestQuoteSignatureVector(t *testing.T) {
	market := common.HexToAddress("0x808192f498a762fc422cdf387646775414cF7bB2")
	price, _ := new(big.Int).SetString("68819100000000005820766", 10)
	digest := QuoteDigest(55452773, market, 0, price, 1794583126)
	// ethers.solidityPackedKeccak256 gives the inner hash; we compare the recovered signer, which covers both.
	signer, err := RecoverSigner(55452773, market, 0, price, 1794583126, "0x32f5b3aee9052e6aea3000f6c1ecac40dea6d2f8b62f204fa24961851393b266310fa4e28f0e8fea6a15051bb01c0ef85c1ae5d2003c94ea086aa1667c22805b1c")
	if err != nil || signer != common.HexToAddress("0x2c7536E3605D9C16a7a3D7b1898e529396a65c23") {
		t.Fatalf("signer %s %v (digest %x)", signer.Hex(), err, digest)
	}
	// any changed field gives another signer
	other, _ := RecoverSigner(55452773, market, 0, new(big.Int).Add(price, big.NewInt(1)), 1794583126, "0x32f5b3aee9052e6aea3000f6c1ecac40dea6d2f8b62f204fa24961851393b266310fa4e28f0e8fea6a15051bb01c0ef85c1ae5d2003c94ea086aa1667c22805b1c")
	if other == signer {
		t.Fatal("price not covered by the signature")
	}
	if _, err := RecoverSigner(55452773, market, 0, price, 1, "0x1234"); err == nil {
		t.Fatal("short signature accepted")
	}
}

func TestFeesAndLeverage(t *testing.T) {
	// Real position #6253340: margin 1 wUSDT ×2, fee 0.1 % → 0.002 wUSDT, liquidation 34608.28 at 69078.2.
	if Fee(big.NewInt(1_000_000), 2, 1000).Int64() != 2000 || Cost(big.NewInt(1_000_000), 2, 1000).Int64() != 1_002_000 {
		t.Fatal("fee")
	}
	if ApprovalNeed(big.NewInt(10_000_000), 5, 1000).Int64() != 10_000_000+50_000+1_000 {
		t.Fatal("approval need = margin + fee + fee/50")
	}
	if MaxSafeLeverage(500, 1000, 1000) != 499 || MaxSafeLeverage(50, 10000, 1000) != 50 {
		t.Fatal("max safe leverage")
	}
	liq := EstimateLiquidation(69078.2, 2, 1000, 1000, true)
	if math.Abs(liq/34608.282-1) > 1e-4 {
		t.Fatalf("liquidation estimate %v", liq)
	}
	if s := EstimateLiquidation(100, 10, 1000, 1000, false); !(s > 100 && s < 110) {
		t.Fatalf("short liquidation %v", s)
	}
	if n := NotionalForRisk(5, 100, 95, true, 0.001); math.Abs(n-98.13542688910697) > 1e-9 {
		t.Fatalf("risk sizing %v", n)
	}
	if NotionalForRisk(5, 100, 105, true, 0.001) != 0 {
		t.Fatal("stop on the wrong side must give 0")
	}
	if MarginFromNotional(big.NewInt(2_000_000), 2).Int64() != 1_000_000 || MarginFromNotional(big.NewInt(1_000_001), 2).Int64() != 500_000 {
		t.Fatal("margin from size rounds down")
	}
}

func f(v float64) *float64 { return &v }

func TestTriggerRules(t *testing.T) {
	ok := func(err error) {
		t.Helper()
		if err != nil {
			t.Fatal(err)
		}
	}
	bad := func(err error) {
		t.Helper()
		if !errs.Is(err, errs.TriggerInvalid) {
			t.Fatalf("expected trigger error, got %v", err)
		}
	}
	ok(TriggerProblems(true, 100, 50, f(110), f(90), false))
	ok(TriggerProblems(false, 100, 150, f(90), f(110), false))
	ok(TriggerProblems(true, 100, 50, nil, nil, false))
	bad(TriggerProblems(true, 100, 50, f(95), nil, false))
	bad(TriggerProblems(true, 100, 50, nil, f(105), false))
	bad(TriggerProblems(true, 100, 50, nil, f(50.01), false)) // inside the 0.05 % liquidation band
	bad(TriggerProblems(false, 100, 150, f(105), nil, false))
	bad(TriggerProblems(false, 100, 150, nil, f(149.99), false))
	if err := TriggerProblems(true, 100, 50, f(95), nil, true); err == nil || !contains(err.Error(), "limit price") {
		t.Fatalf("limit wording: %v", err)
	}
}

func TestLimitAndExpiry(t *testing.T) {
	if LimitProblem(true, 65000, 68000) != nil || LimitProblem(false, 70000, 68000) != nil {
		t.Fatal("valid limits refused")
	}
	if LimitProblem(true, 68000, 68000) == nil || LimitProblem(false, 67000, 68000) == nil || LimitProblem(true, 0, 1) == nil {
		t.Fatal("marketable limit accepted")
	}
	for in, want := range map[string]time.Duration{"7d": 7 * 24 * time.Hour, "12h": 12 * time.Hour, "1w": 7 * 24 * time.Hour, "90m": 90 * time.Minute, "": 30 * 24 * time.Hour} {
		d, err := ParseExpiry(in)
		if err != nil || d != want {
			t.Errorf("%q -> %v %v", in, d, err)
		}
	}
	for _, in := range []string{"91d", "30s", "soon", "-1d"} {
		if _, err := ParseExpiry(in); err == nil {
			t.Errorf("%q accepted", in)
		}
	}
	if _, err := PriceToE18("1.1234567890123"); err == nil {
		t.Error("13 decimals accepted")
	}
	if v, err := PriceToE18("68500.5"); err != nil || v.String() != "68500500000000000000000" {
		t.Errorf("price e18 %v %v", v, err)
	}
}

func TestQuoteFields(t *testing.T) {
	m := common.HexToAddress("0x808192f498a762fc422cdf387646775414cF7bB2")
	now := time.Unix(1_800_000_000, 0)
	c := QuoteCheck{Contract: m, MarketID: 0, Symbol: "BTC_USDT", MaxAgeSec: 20, Now: now}
	if err := ValidateQuoteFields(m.Hex(), 0, "BTC_USDT", now.Unix()-3, c); err != nil {
		t.Fatal(err)
	}
	if err := ValidateQuoteFields("0x6E1DA3b179E4E985f84B784edD44EE20dc74D50f", 0, "BTC_USDT", now.Unix(), c); !errs.Is(err, errs.ContractMismatch) {
		t.Fatalf("contract mismatch: %v", err)
	}
	if err := ValidateQuoteFields(m.Hex(), 1, "ETH_USDT", now.Unix(), c); !errs.Is(err, errs.QuoteExpired) {
		t.Fatalf("market mismatch: %v", err)
	}
	if err := ValidateQuoteFields(m.Hex(), 0, "BTC_USDT", now.Unix()-20, c); !errs.Is(err, errs.QuoteExpired) {
		t.Fatalf("stale quote: %v", err)
	}
}

func contains(s, sub string) bool {
	return len(s) >= len(sub) && (func() bool {
		for i := 0; i+len(sub) <= len(s); i++ {
			if s[i:i+len(sub)] == sub {
				return true
			}
		}
		return false
	})()
}
