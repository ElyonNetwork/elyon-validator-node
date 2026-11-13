// Package spot contains the pure logic of spot trading on the Elyon DEX: Uniswap V2 quote math (the same
// formulas and rounding as the website and @elyonswap/sdk), routes through the wUSDT hub, price impact and
// slippage limits, and market name resolution.
package spot

import (
	"errors"
	"math/big"
)

var (
	feeNum = big.NewInt(997)
	feeDen = big.NewInt(1000)
	bpsDen = big.NewInt(10_000)
	one    = big.NewInt(1)
)

// Hop holds the reserves of one pool in trade direction.
type Hop struct {
	ReserveIn  *big.Int
	ReserveOut *big.Int
}

// ErrLiquidity means the pool cannot provide the requested output.
var ErrLiquidity = errors.New("the pool does not have enough liquidity for this amount")

// GetAmountOut is the canonical Uniswap V2 exact-input formula (0.30 % fee).
func GetAmountOut(amountIn, reserveIn, reserveOut *big.Int) *big.Int {
	if amountIn.Sign() <= 0 || reserveIn.Sign() <= 0 || reserveOut.Sign() <= 0 {
		return new(big.Int)
	}
	inWithFee := new(big.Int).Mul(amountIn, feeNum)
	num := new(big.Int).Mul(inWithFee, reserveOut)
	den := new(big.Int).Add(new(big.Int).Mul(reserveIn, feeDen), inWithFee)
	return num.Quo(num, den)
}

// GetAmountIn is the canonical exact-output formula, including the upstream +1 rounding.
func GetAmountIn(amountOut, reserveIn, reserveOut *big.Int) (*big.Int, error) {
	if amountOut.Sign() <= 0 || reserveIn.Sign() <= 0 || reserveOut.Sign() <= 0 {
		return nil, ErrLiquidity
	}
	if amountOut.Cmp(reserveOut) >= 0 {
		return nil, ErrLiquidity
	}
	num := new(big.Int).Mul(new(big.Int).Mul(reserveIn, amountOut), feeDen)
	den := new(big.Int).Mul(new(big.Int).Sub(reserveOut, amountOut), feeNum)
	return num.Quo(num, den).Add(num, one), nil
}

// QuoteExactIn walks the hops forward.
func QuoteExactIn(amountIn *big.Int, hops []Hop) (*big.Int, error) {
	cur := new(big.Int).Set(amountIn)
	for _, h := range hops {
		cur = GetAmountOut(cur, h.ReserveIn, h.ReserveOut)
		if cur.Sign() == 0 {
			return nil, errors.New("the amount is too small: the trade would return nothing")
		}
	}
	return cur, nil
}

// QuoteExactOut walks the hops backward.
func QuoteExactOut(amountOut *big.Int, hops []Hop) (*big.Int, error) {
	cur := new(big.Int).Set(amountOut)
	for i := len(hops) - 1; i >= 0; i-- {
		in, err := GetAmountIn(cur, hops[i].ReserveIn, hops[i].ReserveOut)
		if err != nil {
			return nil, err
		}
		cur = in
	}
	return cur, nil
}

// PriceImpactBps is the price movement against the pools' mid prices with the 0.30 % fee removed (the
// @elyonswap/sdk priceImpactBps formula).
func PriceImpactBps(hops []Hop, amountIn *big.Int) int64 {
	if amountIn.Sign() <= 0 || len(hops) == 0 {
		return 0
	}
	spotNum := new(big.Int).Set(amountIn)
	spotDen := big.NewInt(1)
	execNum := new(big.Int).Set(amountIn)
	execDen := big.NewInt(1)
	for _, h := range hops {
		if h.ReserveIn.Sign() <= 0 || h.ReserveOut.Sign() <= 0 {
			return 0
		}
		spotNum.Mul(spotNum, h.ReserveOut)
		spotDen.Mul(spotDen, h.ReserveIn)
		execNum.Mul(execNum, h.ReserveOut)
		// executionDenominator = reserveIn * executionDenominator + executionNumerator / reserveOut
		t := new(big.Int).Quo(execNum, h.ReserveOut)
		execDen = new(big.Int).Add(new(big.Int).Mul(h.ReserveIn, execDen), t)
	}
	common := new(big.Int).Mul(spotNum, execDen)
	movement := new(big.Int).Sub(common, new(big.Int).Mul(execNum, spotDen))
	if movement.Sign() <= 0 {
		return 0
	}
	return movement.Mul(movement, bpsDen).Quo(movement, common).Int64()
}

// MinOut = floor(quoted × (10000 − bps) / 10000).
func MinOut(quoted *big.Int, bps int64) *big.Int {
	r := new(big.Int).Mul(quoted, big.NewInt(10_000-bps))
	return r.Quo(r, bpsDen)
}

// MaxIn = ceil(quoted × (10000 + bps) / 10000).
func MaxIn(quoted *big.Int, bps int64) *big.Int {
	r := new(big.Int).Mul(quoted, big.NewInt(10_000+bps))
	r.Add(r, big.NewInt(9_999))
	return r.Quo(r, bpsDen)
}

// MidPrice is the pool price in quote units per base (human numbers).
func MidPrice(reserveBase, reserveQuote *big.Int, baseDecimals, quoteDecimals int) float64 {
	if reserveBase.Sign() <= 0 || reserveQuote.Sign() <= 0 {
		return 0
	}
	q := new(big.Rat).SetFrac(reserveQuote, new(big.Int).Exp(big.NewInt(10), big.NewInt(int64(quoteDecimals)), nil))
	b := new(big.Rat).SetFrac(reserveBase, new(big.Int).Exp(big.NewInt(10), big.NewInt(int64(baseDecimals)), nil))
	f, _ := new(big.Rat).Quo(q, b).Float64()
	return f
}

// SyncToleranceBps is how close the pool must be to the global reference price before the website sends an
// order (MarketSwap.tsx SYNC_TOLERANCE_BPS).
const SyncToleranceBps = 10

// InSync reports whether the pool price is within tolerance of the reference price.
func InSync(mid, reference float64, toleranceBps float64) bool {
	if mid <= 0 || reference <= 0 {
		return false
	}
	d := mid/reference - 1
	if d < 0 {
		d = -d
	}
	return d*10_000 <= toleranceBps
}

// MaxImpactBps is the website's hard limit for a market order (MarketSwap: "Price impact above 15 %").
const MaxImpactBps = 1500
