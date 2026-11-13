// Package futures contains the pure logic of Elyon perpetual futures, mirroring the website's order panel
// (apps/web/src/components/futures/FuturesTrade.tsx) and the contracts (ElyonPerpMarketV3, ElyonPerpTriggersV3,
// ElyonPerpLimitRouter): fees, liquidation estimates, take-profit / stop-loss rules, limit price rules, sizing
// and the verification of the exchange's signed price quotes.
package futures

import (
	"bytes"
	"fmt"
	"math"
	"math/big"
	"strconv"
	"strings"
	"time"

	"github.com/ethereum/go-ethereum/accounts"
	"github.com/ethereum/go-ethereum/common"
	"github.com/ethereum/go-ethereum/common/hexutil"
	"github.com/ethereum/go-ethereum/crypto"

	"github.com/elyon-chain/elyon-bot/internal/amount"
	"github.com/elyon-chain/elyon-bot/internal/errs"
)

// PPM is parts per million.
const PPM = 1_000_000

// MinMarginWUSDT is the smallest margin the website accepts (and the limit router's minMargin): 1 wUSDT.
var MinMargin = big.NewInt(1_000_000)

// Fee is margin × leverage × feePpm / 1e6 in wUSDT base units (the contracts' own formula).
func Fee(margin *big.Int, leverage, feePpm int64) *big.Int {
	f := new(big.Int).Mul(margin, big.NewInt(leverage))
	f.Mul(f, big.NewInt(feePpm))
	return f.Quo(f, big.NewInt(PPM))
}

// Cost is margin + fee: what an open takes from the wallet.
func Cost(margin *big.Int, leverage, feePpm int64) *big.Int {
	return new(big.Int).Add(margin, Fee(margin, leverage, feePpm))
}

// ApprovalNeed is what the website approves for a market open: margin + fee + fee/50.
func ApprovalNeed(margin *big.Int, leverage, feePpm int64) *big.Int {
	fee := Fee(margin, leverage, feePpm)
	n := new(big.Int).Add(margin, fee)
	return n.Add(n, new(big.Int).Quo(fee, big.NewInt(50)))
}

// MaxSafeLeverage is the highest leverage whose margin still covers maintenance + closing fee.
func MaxSafeLeverage(maxLeverage, mmrPpm, feePpm int64) int64 {
	risk := mmrPpm + feePpm
	if risk < 1 {
		risk = 1
	}
	return min(maxLeverage, 999_999/risk)
}

// EstimateLiquidation is @elyonswap/sdk estimateLiquidation (funding excluded).
func EstimateLiquidation(entry float64, leverage, mmrPpm, feePpm int64, long bool) float64 {
	risk := float64(mmrPpm+feePpm) / PPM
	lev := float64(leverage)
	if long {
		return entry * (1 - 1/lev) / (1 - risk)
	}
	return entry * (1 + 1/lev) / (1 + risk)
}

// TriggerProblems checks a take profit / stop loss against the reference price (current price, the fill price,
// or a limit price) and the liquidation price, with the website's wording and 0.05 % liquidation band.
func TriggerProblems(long bool, ref, liquidation float64, tp, sl *float64, limit bool) error {
	where := "the current price"
	if limit {
		where = "your limit price"
	}
	if tp != nil && !(*tp > 0 && ((long && *tp > ref) || (!long && *tp < ref))) {
		side := "above"
		if !long {
			side = "below"
		}
		return errs.Newf(errs.TriggerInvalid, "Take profit must be %s %s (%s).", side, where, amount.Price(ref))
	}
	if sl != nil {
		if !(*sl > 0 && ((long && *sl < ref) || (!long && *sl > ref))) {
			side := "below"
			if !long {
				side = "above"
			}
			return errs.Newf(errs.TriggerInvalid, "Stop loss must be %s %s (%s).", side, where, amount.Price(ref))
		}
		if liquidation > 0 && !((long && *sl > liquidation*1.0005) || (!long && *sl < liquidation*0.9995)) {
			return errs.Newf(errs.TriggerInvalid, "Stop loss must stay before the liquidation price (%s).", amount.Price(liquidation))
		}
	}
	if tp != nil && sl != nil && !((long && *tp > *sl) || (!long && *tp < *sl)) {
		return errs.New(errs.TriggerInvalid, "The take profit must be on the profit side of the stop loss.")
	}
	return nil
}

// LimitProblem is the website's rule: a buy (long) limit waits below the current price, a sell (short) limit
// above it; on the other side it would fill at once and a market order gets the better price.
func LimitProblem(long bool, limit, current float64) error {
	if !(limit > 0) {
		return errs.New(errs.InvalidOrder, "Enter a valid limit price.")
	}
	if current > 0 && long && limit >= current {
		return errs.Newf(errs.InvalidOrder, "A buy (long) limit must be below the current price (%s). At or above it, use a market order: `elyon futures open long …`.", amount.Price(current))
	}
	if current > 0 && !long && limit <= current {
		return errs.Newf(errs.InvalidOrder, "A sell (short) limit must be above the current price (%s). At or below it, use a market order: `elyon futures open short …`.", amount.Price(current))
	}
	return nil
}

// NotionalForRisk is the position size that loses exactly `risk` wUSDT when the stop loss fills at `stop`
// (price move plus the closing fee at the stop) — the website's "size it by risk".
func NotionalForRisk(risk, entry, stop float64, long bool, feeRate float64) float64 {
	if !(risk > 0) || !(entry > 0) || !(stop > 0) {
		return 0
	}
	move := (entry - stop) / entry
	if !long {
		move = (stop - entry) / entry
	}
	if !(move > 0) {
		return 0
	}
	return risk / (move + feeRate*(stop/entry))
}

// MarginFromNotional converts a position size in wUSDT base units into the margin at a leverage (rounded down,
// so the order is never larger than asked).
func MarginFromNotional(notional *big.Int, leverage int64) *big.Int {
	return new(big.Int).Quo(notional, big.NewInt(leverage))
}

// PriceToE18 converts a typed price ("68500", "0.0123") into the contracts' 1e18 scale (at most 12 decimals, like
// the website's input).
func PriceToE18(s string) (*big.Int, error) {
	s = strings.TrimSpace(s)
	_, frac, _ := strings.Cut(s, ".")
	if len(strings.TrimRight(frac, "0")) > 12 {
		return nil, errs.Newf(errs.InvalidInput, "Price %q has more than 12 decimals.", s)
	}
	v, err := amount.ParsePositive(s, 18)
	if err != nil {
		return nil, errs.Newf(errs.InvalidInput, "Price: %v", err)
	}
	return v, nil
}

// ParseExpiry parses "7d", "12h", "90m", "1w" or a Go duration; limit orders live 1 minute to 90 days.
func ParseExpiry(s string) (time.Duration, error) {
	s = strings.ToLower(strings.TrimSpace(s))
	if s == "" {
		return 30 * 24 * time.Hour, nil
	}
	var d time.Duration
	unit := s[len(s)-1]
	if n, err := strconv.ParseFloat(s[:len(s)-1], 64); err == nil && (unit == 'd' || unit == 'w') {
		mult := 24.0
		if unit == 'w' {
			mult = 24 * 7
		}
		d = time.Duration(n * mult * float64(time.Hour))
	} else {
		var err error
		d, err = time.ParseDuration(s)
		if err != nil {
			return 0, errs.Newf(errs.InvalidInput, "Expiry %q: use a duration like 30m, 12h, 7d or 4w.", s)
		}
	}
	if d < time.Minute || d > 90*24*time.Hour {
		return 0, errs.New(errs.InvalidInput, "A limit order must expire between 1 minute and 90 days from now.")
	}
	return d, nil
}

// QuoteDigest is keccak256("\x19Ethereum Signed Message:\n32" ‖ keccak256("ELYON_PERP_QUOTE" ‖ chainid ‖ market ‖
// marketId ‖ priceE18 ‖ timestamp)) with Solidity abi.encodePacked widths (uint256, address, uint256, uint128,
// uint64) — ElyonPerpMarketV3.quoteDigest.
func QuoteDigest(chainID int64, market common.Address, marketID int64, priceE18 *big.Int, timestamp int64) []byte {
	var buf bytes.Buffer
	buf.WriteString("ELYON_PERP_QUOTE")
	buf.Write(common.LeftPadBytes(big.NewInt(chainID).Bytes(), 32))
	buf.Write(market.Bytes())
	buf.Write(common.LeftPadBytes(big.NewInt(marketID).Bytes(), 32))
	buf.Write(common.LeftPadBytes(priceE18.Bytes(), 16))
	buf.Write(common.LeftPadBytes(big.NewInt(timestamp).Bytes(), 8))
	inner := crypto.Keccak256(buf.Bytes())
	return accounts.TextHash(inner)
}

// RecoverSigner returns the address that signed a quote.
func RecoverSigner(chainID int64, market common.Address, marketID int64, priceE18 *big.Int, timestamp int64, signature string) (common.Address, error) {
	sig, err := hexutil.Decode(signature)
	if err != nil || len(sig) != 65 {
		return common.Address{}, fmt.Errorf("malformed quote signature")
	}
	s := make([]byte, 65)
	copy(s, sig)
	if s[64] >= 27 {
		s[64] -= 27
	}
	pub, err := crypto.SigToPub(QuoteDigest(chainID, market, marketID, priceE18, timestamp), s)
	if err != nil {
		return common.Address{}, err
	}
	return crypto.PubkeyToAddress(*pub), nil
}

// QuoteCheck is what a signed quote must match before it is used.
type QuoteCheck struct {
	Contract  common.Address
	MarketID  int64
	Symbol    string
	MaxAgeSec int64
	Now       time.Time
}

// ValidateQuoteFields checks a quote's contract, market, symbol and age exactly like the website does before it
// asks the wallet to sign.
func ValidateQuoteFields(contract string, marketID int64, symbol string, timestamp int64, c QuoteCheck) error {
	if !common.IsHexAddress(contract) || common.HexToAddress(contract) != c.Contract {
		return errs.New(errs.ContractMismatch, "The price quote was signed for another futures contract.").WithHint("Update elyon-bot; the exchange may have moved to a new contract.")
	}
	if marketID != c.MarketID || symbol != c.Symbol {
		return errs.New(errs.QuoteExpired, "The price quote is for another market.").WithHint("Retry.")
	}
	age := c.Now.Unix() - timestamp
	if age >= c.MaxAgeSec || age < -60 {
		return errs.New(errs.QuoteExpired, "The price quote expired before it could be used.").WithHint("Retry the command; it fetches a fresh price.")
	}
	return nil
}

// FloatOrZero dereferences an optional API price.
func FloatOrZero(p *float64) float64 {
	if p == nil || math.IsNaN(*p) {
		return 0
	}
	return *p
}
