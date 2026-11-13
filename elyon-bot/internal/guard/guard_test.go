package guard

import (
	"math/big"
	"testing"
	"time"

	"github.com/ethereum/go-ethereum/common"

	"github.com/elyon-chain/elyon-bot/internal/errs"
	"github.com/elyon-chain/elyon-bot/internal/keystore"
)

var (
	dest    = common.HexToAddress("0x0E0bB1BDEc7248eBac6eFBE624ceAEd86bda3e27")
	other   = common.HexToAddress("0x000000000000000000000000000000000000bEEF")
	wusdt   = "0x3d768c1838188dca395489ae5d6b2c897a936f61"
	allow   = []keystore.AllowEntry{{Address: dest.Hex(), Label: "dex"}}
	limits  = []keystore.DailyLimit{{Token: wusdt, Symbol: "wUSDT", Decimals: 6, Amount: "100000000"}} // 100 wUSDT
	nothing = big.NewInt(0)
)

func req(to common.Address, amt int64, pw bool) Request {
	return Request{To: to, Token: wusdt, Symbol: "wUSDT", Decimals: 6, Amount: big.NewInt(amt), PasswordOK: pw}
}

func TestTransferRules(t *testing.T) {
	if err := Authorize(req(other, 1, false), allow, nil, nothing); !errs.Is(err, errs.TransferNotAllowed) {
		t.Fatalf("unknown destination without password: %v", err)
	}
	if err := Authorize(req(dest, 1, false), allow, nil, nothing); err != nil {
		t.Fatalf("approved destination: %v", err)
	}
	if err := Authorize(req(other, 1, true), allow, nil, nothing); err != nil {
		t.Fatalf("password given: %v", err)
	}
	if err := Authorize(req(dest, 60_000_000, false), allow, limits, big.NewInt(50_000_000)); !errs.Is(err, errs.DailyLimit) {
		t.Fatalf("limit exceeded: %v", err)
	}
	if err := Authorize(req(other, 60_000_000, true), allow, limits, big.NewInt(50_000_000)); !errs.Is(err, errs.DailyLimit) {
		t.Fatalf("the limit also applies with the password: %v", err)
	}
	if err := Authorize(req(dest, 50_000_000, false), allow, limits, big.NewInt(50_000_000)); err != nil {
		t.Fatalf("exactly the limit: %v", err)
	}
	eln := Request{To: dest, Token: "native", Symbol: "ELN", Decimals: 18, Amount: big.NewInt(1e18)}
	if err := Authorize(eln, allow, limits, nothing); err != nil {
		t.Fatalf("a wUSDT limit must not apply to ELN: %v", err)
	}
}

func TestLedger(t *testing.T) {
	home := t.TempDir()
	l := LoadLedger(home)
	now := time.Now()
	_ = l.Record(Entry{Time: now.Add(-25 * time.Hour), Token: wusdt, Amount: "70000000", To: dest.Hex(), Tx: "0x1"})
	_ = l.Record(Entry{Time: now.Add(-2 * time.Hour), Token: wusdt, Amount: "30000000", To: dest.Hex(), Tx: "0x2"})
	_ = l.Record(Entry{Time: now.Add(-1 * time.Hour), Token: "native", Amount: "5", To: dest.Hex(), Tx: "0x3"})
	if got := l.Spent(wusdt, now); got.Int64() != 30_000_000 {
		t.Fatalf("spent in window %s", got)
	}
	reloaded := LoadLedger(home)
	if reloaded.Spent(wusdt, now).Int64() != 30_000_000 || len(reloaded.Entries) != 3 {
		t.Fatal("ledger not persisted")
	}
	// Merge picks up what another process recorded.
	other := LoadLedger(home)
	_ = other.Record(Entry{Time: now, Token: wusdt, Amount: "1000000", To: dest.Hex(), Tx: "0x4"})
	l.Merge()
	if l.Spent(wusdt, now).Int64() != 31_000_000 {
		t.Fatalf("merge %s", l.Spent(wusdt, now))
	}
}
