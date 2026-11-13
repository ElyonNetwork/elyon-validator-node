// Package amount parses and formats token amounts exactly, without floating point.
//
// Every amount that reaches a transaction goes through Parse, which rejects anything that is not a plain
// non-negative decimal number (no signs, exponents or thousands separators) and anything with more decimal
// places than the token supports. Nothing is ever rounded silently.
package amount

import (
	"errors"
	"fmt"
	"math"
	"math/big"
	"strconv"
	"strings"
)

var (
	ten = big.NewInt(10)
	// ErrEmpty is returned when no amount was given.
	ErrEmpty = errors.New("enter an amount, for example 10 or 0.5")
)

// Pow10 returns 10^n as a new big.Int.
func Pow10(n int) *big.Int { return new(big.Int).Exp(ten, big.NewInt(int64(n)), nil) }

// Parse converts a human decimal string ("10", "0.5", ".25") into base units of a token with `decimals` decimals.
func Parse(s string, decimals int) (*big.Int, error) {
	if decimals < 0 || decimals > 77 {
		return nil, fmt.Errorf("invalid token decimals %d", decimals)
	}
	s = strings.TrimSpace(s)
	if s == "" {
		return nil, ErrEmpty
	}
	if strings.Contains(s, ",") {
		return nil, fmt.Errorf("%q: use a dot for decimals and no thousands separators (for example 1234.5)", s)
	}
	if strings.HasPrefix(s, "-") {
		return nil, fmt.Errorf("%q: the amount cannot be negative", s)
	}
	if strings.HasPrefix(s, "+") {
		s = s[1:]
	}
	whole, frac, hasDot := strings.Cut(s, ".")
	if hasDot && strings.Contains(frac, ".") {
		return nil, fmt.Errorf("%q is not a number", s)
	}
	if whole == "" && frac == "" {
		return nil, fmt.Errorf("%q is not a number", s)
	}
	for _, part := range []string{whole, frac} {
		for _, r := range part {
			if r < '0' || r > '9' {
				return nil, fmt.Errorf("%q is not a plain number (use digits and one dot, for example 0.5)", s)
			}
		}
	}
	if len(frac) > decimals {
		trimmed := strings.TrimRight(frac, "0")
		if len(trimmed) > decimals {
			if decimals == 0 {
				return nil, fmt.Errorf("%q: this token has no decimals, use a whole number", s)
			}
			return nil, fmt.Errorf("%q has too many decimal places: this token has %d", s, decimals)
		}
		frac = trimmed
	}
	if whole == "" {
		whole = "0"
	}
	digits := whole + frac + strings.Repeat("0", decimals-len(frac))
	v, ok := new(big.Int).SetString(digits, 10)
	if !ok {
		return nil, fmt.Errorf("%q is not a number", s)
	}
	return v, nil
}

// ParsePositive is Parse that also rejects zero.
func ParsePositive(s string, decimals int) (*big.Int, error) {
	v, err := Parse(s, decimals)
	if err != nil {
		return nil, err
	}
	if v.Sign() <= 0 {
		return nil, fmt.Errorf("%q: the amount must be greater than zero", strings.TrimSpace(s))
	}
	return v, nil
}

// Format renders base units as an exact decimal string with trailing zeros removed ("1.5", "0.000001", "12").
func Format(v *big.Int, decimals int) string {
	if v == nil {
		return "0"
	}
	neg := v.Sign() < 0
	abs := new(big.Int).Abs(v)
	s := abs.String()
	if decimals > 0 {
		if len(s) <= decimals {
			s = strings.Repeat("0", decimals-len(s)+1) + s
		}
		s = s[:len(s)-decimals] + "." + s[len(s)-decimals:]
		s = strings.TrimRight(strings.TrimRight(s, "0"), ".")
	}
	if neg && s != "0" {
		return "-" + s
	}
	return s
}

// FormatMax renders base units with at most maxFrac decimal places, rounding toward zero (never shows more than
// is really there). Trailing zeros are removed.
func FormatMax(v *big.Int, decimals, maxFrac int) string {
	if v == nil {
		return "0"
	}
	if maxFrac >= decimals {
		return Format(v, decimals)
	}
	cut := Pow10(decimals - maxFrac)
	q := new(big.Int).Quo(v, cut) // truncates toward zero
	return Format(q, maxFrac)
}

// FormatSig renders base units for display with about `sig` significant digits (at least 2 decimals kept for
// amounts ≥ 1, more for small amounts), rounding toward zero.
func FormatSig(v *big.Int, decimals, sig int) string {
	if v == nil || v.Sign() == 0 {
		return "0"
	}
	abs := new(big.Int).Abs(v)
	intDigits := len(abs.String()) - decimals // digits before the dot (≤ 0 for amounts < 1)
	frac := sig - intDigits
	if frac < 0 {
		frac = 0
	}
	if intDigits >= 1 && frac < 2 {
		frac = 2
	}
	return FormatMax(v, decimals, frac)
}

// ToFloat converts base units to a float64 for estimates and display only (never for transactions).
func ToFloat(v *big.Int, decimals int) float64 {
	if v == nil {
		return 0
	}
	f, _ := new(big.Rat).SetFrac(v, Pow10(decimals)).Float64()
	return f
}

// FromFloat converts a float (as served by the price APIs) into base units using its shortest exact decimal form.
func FromFloat(f float64, decimals int) (*big.Int, error) {
	if math.IsNaN(f) || math.IsInf(f, 0) || f < 0 {
		return nil, fmt.Errorf("invalid number %v", f)
	}
	s := strconv.FormatFloat(f, 'f', -1, 64)
	whole, frac, _ := strings.Cut(s, ".")
	if len(frac) > decimals {
		frac = frac[:decimals]
	}
	return Parse(whole+"."+frac, decimals)
}

// Group inserts thousands separators into the integer part of a decimal string: "68819.1" → "68,819.1".
func Group(s string) string {
	neg := strings.HasPrefix(s, "-")
	if neg {
		s = s[1:]
	}
	whole, frac, hasDot := strings.Cut(s, ".")
	var b strings.Builder
	for i, r := range whole {
		if i > 0 && (len(whole)-i)%3 == 0 {
			b.WriteByte(',')
		}
		b.WriteRune(r)
	}
	out := b.String()
	if hasDot {
		out += "." + frac
	}
	if neg {
		out = "-" + out
	}
	return out
}

// Price formats a price for humans like the website does: ≥ 1000 with 2 decimals and grouping, ≥ 1 with 4
// decimals, below 1 with 4 significant digits.
func Price(p float64) string {
	if math.IsNaN(p) || math.IsInf(p, 0) {
		return "—"
	}
	switch {
	case p >= 1000:
		return Group(strconv.FormatFloat(p, 'f', 2, 64))
	case p >= 1:
		return strconv.FormatFloat(p, 'f', 4, 64)
	case p == 0:
		return "0"
	default:
		return strconv.FormatFloat(p, 'g', 4, 64)
	}
}

// PriceE18 formats a 1e18-scaled price like Price, using the exact value.
func PriceE18(v *big.Int) string { return Price(ToFloat(v, 18)) }

// ParsePercent parses "50", "50%" or "12.5" into basis points of a hundred percent (50% → 5000).
func ParsePercent(s string) (int64, error) {
	s = strings.TrimSuffix(strings.TrimSpace(s), "%")
	v, err := Parse(s, 2)
	if err != nil {
		return 0, fmt.Errorf("percent: %w", err)
	}
	if v.Sign() <= 0 || v.Cmp(big.NewInt(10000)) > 0 {
		return 0, fmt.Errorf("percent must be between 0.01 and 100")
	}
	return v.Int64(), nil
}

// MulDiv returns a*b/c rounded down.
func MulDiv(a, b, c *big.Int) *big.Int {
	r := new(big.Int).Mul(a, b)
	return r.Quo(r, c)
}
