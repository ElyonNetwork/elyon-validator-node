package chain

import (
	"encoding/hex"
	"errors"
	"testing"

	"github.com/ethereum/go-ethereum/accounts/abi"

	"github.com/elyon-chain/elyon-bot/internal/errs"
)

type dataErr struct{ msg, data string }

func (e dataErr) Error() string          { return e.msg }
func (e dataErr) ErrorCode() int         { return -32015 }
func (e dataErr) ErrorData() interface{} { return e.data }

func TestRevertReasonFormats(t *testing.T) {
	cases := map[error]string{
		dataErr{"VM execution error.", "err: TOKEN: balance (supplied gas 50000000)"}: "TOKEN: balance", // Elyon node format
		dataErr{"VM execution error.", "err: revert (supplied gas 50000000)"}:         "revert",
		dataErr{"execution reverted", errorStringData("PERP: quote stale")}:           "PERP: quote stale",
		errors.New("execution reverted: UniswapV2Router: INSUFFICIENT_OUTPUT_AMOUNT"): "UniswapV2Router: INSUFFICIENT_OUTPUT_AMOUNT",
	}
	for err, want := range cases {
		got, ok := RevertReason(err)
		if !ok || got != want {
			t.Errorf("%v -> %q %v, want %q", err, got, ok, want)
		}
	}
	if _, ok := RevertReason(errors.New("connection refused")); ok {
		t.Error("network error taken for a revert")
	}
}

func TestFriendlyMapping(t *testing.T) {
	cases := map[string]string{
		"PERP: quote stale":                           errs.QuoteExpired,
		"TRIG: stop-loss beyond liquidation":          errs.TriggerInvalid,
		"TRIG: not trader":                            errs.NotYours,
		"PERP: not open":                              errs.AlreadyClosed,
		"PERP: liquidatable":                          errs.Liquidatable,
		"LIMIT: too many open orders":                 errs.OrderLimitReached,
		"UniswapV2Router: INSUFFICIENT_OUTPUT_AMOUNT": errs.PriceMoved,
		"UniswapV2Router: EXPIRED":                    errs.PriceMoved,
		"TOKEN: balance":                              errs.InsufficientBalance,
		"GAS: daily limit reached":                    errs.DailyLimit,
		"PERP: market disabled":                       errs.MarketCloseOnly,
		"something unknown":                           errs.TxReverted,
	}
	for reason, code := range cases {
		e := MapRevert(reason, RevertContext{"symbol": "wUSDT"}, "open position")
		if e.Code != code || e.Message == "" {
			t.Errorf("%q -> %s %q, want %s", reason, e.Code, e.Message, code)
		}
	}
	if e := MapRevert("TOKEN: balance", RevertContext{"symbol": "wBTC"}, ""); e.Message != "You do not hold enough wBTC for this amount." {
		t.Errorf("symbol in message: %q", e.Message)
	}
}

// errorStringData encodes Error(string) like a standard Solidity revert.
func errorStringData(msg string) string {
	str, _ := abi.NewType("string", "", nil)
	packed, _ := abi.Arguments{{Type: str}}.Pack(msg)
	return "0x08c379a0" + hex.EncodeToString(packed)
}
