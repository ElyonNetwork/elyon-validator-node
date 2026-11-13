package registry

import (
	"testing"

	"github.com/ethereum/go-ethereum/common"
)

func TestBuiltinRegistry(t *testing.T) {
	if len(All()) < 1300 {
		t.Fatalf("only %d tokens embedded", len(All()))
	}
	btc, ok := ByBase("btc")
	if !ok || btc.Symbol != "wBTC" || btc.Addr() != common.HexToAddress("0x674cAF9F5996F9A68875F5C385d81ECc5A501048") || btc.Decimals != 18 {
		t.Fatalf("wBTC entry %+v", btc)
	}
	usdt, ok := ByBase("USDT")
	if !ok || usdt.Decimals != 6 || usdt.Addr() != common.HexToAddress("0x3D768c1838188DcA395489ae5D6b2C897A936f61") {
		t.Fatalf("wUSDT entry %+v", usdt)
	}
	if Check("BTC", btc.Addr()) != Known {
		t.Error("known token not recognised")
	}
	if Check("BTC", common.HexToAddress("0x000000000000000000000000000000000000dEaD")) != Mismatch {
		t.Error("look-alike token for a known ticker accepted")
	}
	if Check("NEWCOIN2099", common.HexToAddress("0x000000000000000000000000000000000000dEaD")) != New {
		t.Error("new listing not reported as new")
	}
	if Check("NEWCOIN2099", btc.Addr()) != Mismatch {
		t.Error("a known contract under a new ticker accepted")
	}
}
