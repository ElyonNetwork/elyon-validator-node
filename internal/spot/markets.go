package spot

import (
	"fmt"
	"sort"
	"strings"

	"github.com/ethereum/go-ethereum/common"

	"github.com/elyon-chain/elyon-bot/internal/errs"
)

// WELNAddress is the router's wrapped native coin on ElyonChain.
var WELNAddress = common.HexToAddress("0xD48412aCe1346EAC5E4D0c9e613DBb7C2d25c1EE")

// ElnLockMessage is the website's notice (owner decision 2026-11-11).
const ElnLockMessage = "ELN is not traded on ElyonDex until its exchange listing. To pay network fees, buy ELN for gas at a fixed price with wUSDT: `elyon gas buy <ELN amount>`."

// Market is a spot market: a wrapped token traded against wUSDT in its Uniswap V2 pool.
type Market struct {
	Base      string         `json:"base"`
	Display   string         `json:"symbol"`
	Name      string         `json:"name"`
	Token     common.Address `json:"token"`
	Pool      common.Address `json:"pool"`
	Decimals  int            `json:"decimals"`
	Tier      string         `json:"tier"`
	New       bool           `json:"new_since_release,omitempty"`
	Price     *float64       `json:"pool_price,omitempty"`
	Reference *float64       `json:"reference_price,omitempty"`
	Change24h *float64       `json:"change_24h_pct,omitempty"`
	Volume24h float64        `json:"volume_24h_wusdt"`
	Liquidity *float64       `json:"liquidity_wusdt,omitempty"`
	FeedOK    bool           `json:"feed_ok"`
	At        string         `json:"price_time,omitempty"`
}

// Label is how a market is named in messages: "wBTC (Bitcoin)".
func (m *Market) Label() string {
	if m.Name != "" && !strings.EqualFold(m.Name, m.Base) {
		return m.Display + " (" + m.Name + ")"
	}
	return m.Display
}

// IsELN reports whether a typed asset means ELN or WELN (never tradable on ElyonDex for now).
func IsELN(s string) bool {
	t := strings.TrimSpace(s)
	switch strings.ToUpper(t) {
	case "ELN", "WELN", "NATIVE", "ELYON":
		return true
	}
	return common.IsHexAddress(t) && common.HexToAddress(t) == WELNAddress
}

// IsWUSDT reports whether a typed asset means wUSDT.
func IsWUSDT(s string, wusdt common.Address) bool {
	t := strings.TrimSpace(s)
	switch strings.ToUpper(t) {
	case "WUSDT", "USDT", "USD":
		return true
	}
	return common.IsHexAddress(t) && common.HexToAddress(t) == wusdt
}

// Resolve finds the market a user means: an address, "wBTC", "BTC", "btc"… Ambiguous inputs are refused with
// the choices, never guessed (for example "wbtc" could be wBTC = Bitcoin or wWBTC = Wrapped Bitcoin).
func Resolve(input string, markets []Market) (*Market, error) {
	in := strings.TrimSpace(input)
	if in == "" {
		return nil, errs.New(errs.InvalidInput, "Name the market, for example BTC or wBTC.")
	}
	if IsELN(in) {
		return nil, errs.New(errs.ElnNotTradable, ElnLockMessage)
	}
	if common.IsHexAddress(in) {
		a := common.HexToAddress(in)
		for i := range markets {
			if markets[i].Token == a {
				return &markets[i], nil
			}
		}
		return nil, errs.Newf(errs.UnknownMarket, "No spot market trades the token %s.", a.Hex())
	}
	for i := range markets {
		if markets[i].Display == in {
			return &markets[i], nil
		}
	}
	for i := range markets {
		if markets[i].Base == in {
			return &markets[i], nil
		}
	}
	var cands []*Market
	seen := map[string]bool{}
	add := func(m *Market) {
		if !seen[m.Base] {
			seen[m.Base] = true
			cands = append(cands, m)
		}
	}
	for i := range markets {
		if strings.EqualFold(markets[i].Base, in) || strings.EqualFold(markets[i].Display, in) {
			add(&markets[i])
		}
	}
	if len(cands) == 0 && (in[0] == 'w' || in[0] == 'W') && len(in) > 1 {
		for i := range markets {
			if strings.EqualFold(markets[i].Base, in[1:]) {
				add(&markets[i])
			}
		}
	}
	switch len(cands) {
	case 1:
		return cands[0], nil
	case 0:
		e := errs.Newf(errs.UnknownMarket, "There is no spot market %q.", in)
		if s := suggest(in, markets); s != "" {
			e.WithHint("Did you mean " + s + "? List markets with `elyon spot markets --search " + strings.TrimLeft(strings.ToUpper(in), "W") + "`.")
		} else {
			e.WithHint("List markets with `elyon spot markets --search <text>`.")
		}
		return nil, e
	default:
		var opts []string
		for _, c := range cands {
			opts = append(opts, fmt.Sprintf("%s = %s (type %s)", c.Display, c.Name, c.Base))
		}
		return nil, errs.Newf(errs.AmbiguousMarket, "%q matches more than one market: %s.", in, strings.Join(opts, "; ")).WithHint("Type the exact ticker shown, with matching upper/lower case.")
	}
}

func suggest(in string, markets []Market) string {
	q := strings.ToUpper(strings.TrimLeft(in, "wW"))
	var out []string
	for _, m := range markets {
		if strings.HasPrefix(strings.ToUpper(m.Base), q) {
			out = append(out, m.Display)
			if len(out) == 5 {
				break
			}
		}
	}
	return strings.Join(out, ", ")
}

// Search filters markets by ticker or name (ticker matches first), like the website's pair search.
func Search(markets []Market, q string) []Market {
	q = strings.ToUpper(strings.TrimSpace(q))
	if q == "" {
		return markets
	}
	type scored struct {
		m Market
		s int
	}
	var hits []scored
	for _, m := range markets {
		b, d, n := strings.ToUpper(m.Base), strings.ToUpper(m.Display), strings.ToUpper(m.Name)
		s := 0
		switch {
		case b == q || d == q:
			s = 4
		case strings.HasPrefix(b, q) || strings.HasPrefix(d, q):
			s = 3
		case strings.Contains(b, q):
			s = 2
		case strings.Contains(n, q):
			s = 1
		}
		if s > 0 {
			hits = append(hits, scored{m, s})
		}
	}
	sort.SliceStable(hits, func(i, j int) bool {
		if hits[i].s != hits[j].s {
			return hits[i].s > hits[j].s
		}
		return hits[i].m.Volume24h > hits[j].m.Volume24h
	})
	out := make([]Market, len(hits))
	for i, h := range hits {
		out[i] = h.m
	}
	return out
}
