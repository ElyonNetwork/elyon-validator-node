// Package dex reads the public HTTP API of the Elyon DEX (https://dex.elyon.network): market lists, prices,
// signed futures quotes and the trade history the website shows. It never sends anything about the user except
// the wallet address in the two history queries (positions, orders), exactly like the website.
package dex

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"math/big"
	"net/http"
	"net/url"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/elyon-chain/elyon-bot/internal/errs"
	"github.com/elyon-chain/elyon-bot/internal/version"
)

// Client is a DEX API client with a small response cache.
type Client struct {
	Base string
	HTTP *http.Client

	mu    sync.Mutex
	cache map[string]cached
}

type cached struct {
	at   time.Time
	body []byte
}

// New returns a client for base (e.g. https://dex.elyon.network).
func New(base string) *Client {
	return &Client{Base: strings.TrimRight(base, "/"), HTTP: &http.Client{Timeout: 30 * time.Second}, cache: map[string]cached{}}
}

func (c *Client) get(ctx context.Context, path string, ttl time.Duration, out any) error {
	u := c.Base + path
	if ttl > 0 {
		c.mu.Lock()
		hit, ok := c.cache[u]
		c.mu.Unlock()
		if ok && time.Since(hit.at) < ttl {
			return json.Unmarshal(hit.body, out)
		}
	}
	var lastErr error
	for attempt := 0; attempt < 3; attempt++ {
		body, status, retryAfter, err := c.fetch(ctx, u)
		if err != nil {
			lastErr = errs.Newf(errs.APIUnavailable, "The Elyon DEX API (%s) is unreachable right now.", c.Base).WithHint("Check your internet connection and retry.").Wrap(err)
		} else if status == http.StatusOK {
			if ttl > 0 {
				c.mu.Lock()
				c.cache[u] = cached{at: time.Now(), body: body}
				c.mu.Unlock()
			}
			if err := json.Unmarshal(body, out); err != nil {
				return errs.Newf(errs.APIUnavailable, "The Elyon DEX API sent an unexpected answer for %s.", path).Wrap(err)
			}
			return nil
		} else {
			msg := apiErrorMessage(body)
			switch {
			case status == http.StatusTooManyRequests:
				lastErr = errs.New(errs.RateLimited, "The Elyon DEX API asks to slow down (too many requests).").WithHint("Wait a few seconds and retry.")
				if retryAfter > 0 && retryAfter <= 5*time.Second && attempt < 2 {
					time.Sleep(retryAfter)
					continue
				}
				return lastErr
			case status >= 500:
				lastErr = &apiStatusError{status: status, msg: msg}
			default:
				return &apiStatusError{status: status, msg: msg}
			}
		}
		if ctx.Err() != nil {
			break
		}
		time.Sleep(time.Duration(400*(attempt+1)) * time.Millisecond)
	}
	return lastErr
}

func (c *Client) fetch(ctx context.Context, u string) ([]byte, int, time.Duration, error) {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, u, nil)
	if err != nil {
		return nil, 0, 0, err
	}
	req.Header.Set("User-Agent", version.UserAgent())
	req.Header.Set("Accept", "application/json")
	resp, err := c.HTTP.Do(req)
	if err != nil {
		return nil, 0, 0, err
	}
	defer resp.Body.Close()
	body, err := io.ReadAll(io.LimitReader(resp.Body, 16<<20))
	if err != nil {
		return nil, 0, 0, err
	}
	var ra time.Duration
	if s := resp.Header.Get("Retry-After"); s != "" {
		if n, err := strconv.Atoi(s); err == nil {
			ra = time.Duration(n) * time.Second
		}
	}
	return body, resp.StatusCode, ra, nil
}

// apiStatusError is a non-200 answer; StatusError exposes it for callers that care (404 unknown market…).
type apiStatusError struct {
	status int
	msg    string
}

func (e *apiStatusError) Error() string {
	if e.msg != "" {
		return fmt.Sprintf("DEX API %d: %s", e.status, e.msg)
	}
	return fmt.Sprintf("DEX API status %d", e.status)
}

// StatusOf returns the HTTP status and message of an API error (0 if err is not one).
func StatusOf(err error) (int, string) {
	var e *apiStatusError
	if errors.As(err, &e) {
		return e.status, e.msg
	}
	return 0, ""
}

func apiErrorMessage(body []byte) string {
	var a struct {
		Error json.RawMessage `json:"error"`
	}
	if json.Unmarshal(body, &a) != nil || len(a.Error) == 0 {
		return ""
	}
	var s string
	if json.Unmarshal(a.Error, &s) == nil {
		return s
	}
	var o struct {
		Message string `json:"message"`
	}
	if json.Unmarshal(a.Error, &o) == nil {
		return o.Message
	}
	return ""
}

// ---------------------------------------------------------------- futures

// FuturesMarket is one perpetual market as served by /api/futures/markets.
type FuturesMarket struct {
	Symbol      string   `json:"symbol"`
	Base        string   `json:"base"`
	Name        *string  `json:"name"`
	Category    string   `json:"category"`
	ID          int64    `json:"id"`
	MaxLeverage int64    `json:"maxLeverage"`
	MmrPpm      int64    `json:"mmrPpm"`
	FeePpm      int64    `json:"feePpm"`
	FeeRate     float64  `json:"feeRate"`
	Last        *float64 `json:"last"`
	Fair        *float64 `json:"fair"`
	Index       *float64 `json:"index"`
	FundingRate *float64 `json:"fundingRate"`
	Amount24    float64  `json:"amount24"`
	Trades24h   int64    `json:"trades24h"`
	Change24Pct float64  `json:"change24Pct"`
	High24      *float64 `json:"high24"`
	Low24       *float64 `json:"low24"`
	Closed      bool     `json:"closed"`
	CloseOnly   bool     `json:"closeOnly"`
	At          *string  `json:"at"`
}

// FuturesMarkets is /api/futures/markets.
type FuturesMarkets struct {
	Contract           string          `json:"contract"`
	Triggers           string          `json:"triggers"`
	LimitRouter        *string         `json:"limitRouter"`
	Quote              string          `json:"quote"`
	MaxQuoteAgeSeconds int64           `json:"maxQuoteAgeSeconds"`
	MaxNotionalUsdt    string          `json:"maxNotionalUsdt"`
	FeeRule            string          `json:"feeRule"`
	Markets            []FuturesMarket `json:"markets"`
	FeedAt             *string         `json:"feedAt"`
	ServerTime         string          `json:"serverTime"`
}

// FuturesMarkets returns every perpetual market (cached ~2 s).
func (c *Client) FuturesMarkets(ctx context.Context) (*FuturesMarkets, error) {
	var out FuturesMarkets
	if err := c.get(ctx, "/api/futures/markets", 2*time.Second, &out); err != nil {
		return nil, err
	}
	if len(out.Markets) == 0 {
		return nil, errs.New(errs.APIUnavailable, "The futures market list is empty right now (the price feed may be restarting).").WithHint("Retry in a few seconds.")
	}
	return &out, nil
}

// Mark is the live price of one market (/api/futures/mark).
type Mark struct {
	Last        *float64 `json:"last"`
	Fair        *float64 `json:"fair"`
	Index       *float64 `json:"index"`
	FundingRate *float64 `json:"fundingRate"`
	Change24Pct float64  `json:"change24Pct"`
	At          *string  `json:"at"`
}

// Marks returns live prices for up to 50 symbols.
func (c *Client) Marks(ctx context.Context, symbols []string) (map[string]Mark, error) {
	out := map[string]Mark{}
	for i := 0; i < len(symbols); i += 50 {
		end := min(i+50, len(symbols))
		var r struct {
			Marks map[string]Mark `json:"marks"`
		}
		if err := c.get(ctx, "/api/futures/mark?symbols="+url.QueryEscape(strings.Join(symbols[i:end], ",")), 0, &r); err != nil {
			return nil, err
		}
		for k, v := range r.Marks {
			out[k] = v
		}
	}
	return out, nil
}

// SignedQuote is a price signed by the exchange's feeder, valid for maxQuoteAge seconds on-chain.
type SignedQuote struct {
	Symbol    string  `json:"symbol"`
	MarketID  int64   `json:"marketId"`
	Price     float64 `json:"price"`
	Kind      string  `json:"kind"`
	PriceE18  string  `json:"priceE18"`
	Timestamp int64   `json:"timestamp"`
	Signature string  `json:"signature"`
	Contract  string  `json:"contract"`
}

// PriceE18Int parses PriceE18.
func (q *SignedQuote) PriceE18Int() (*big.Int, bool) { return new(big.Int).SetString(q.PriceE18, 10) }

// Quote fetches a fresh signed quote for symbol, signed for the market contract (exactly the request the website
// makes: kind=last; the signer always signs the last price).
func (c *Client) Quote(ctx context.Context, symbol, contract string) (*SignedQuote, error) {
	path := "/api/futures/quote?symbol=" + url.QueryEscape(symbol) + "&kind=last"
	if contract != "" {
		path += "&contract=" + url.QueryEscape(contract)
	}
	var q SignedQuote
	err := c.get(ctx, path, 0, &q)
	if err != nil {
		status, msg := StatusOf(err)
		switch {
		case status == http.StatusServiceUnavailable && strings.Contains(strings.ToLower(msg), "clos"):
			return nil, errs.Newf(errs.MarketClosed, "%s is outside its trading hours: %s", symbol, msg).WithHint("Positions cannot be opened or closed until the underlying market reopens; open positions stay open.")
		case status == http.StatusServiceUnavailable:
			if msg == "" {
				msg = "The price feed is temporarily unavailable."
			}
			return nil, errs.Newf(errs.QuoteUnavailable, "No signed price for %s right now: %s", symbol, msg).WithHint("Retry in a few seconds.")
		case status == http.StatusNotFound:
			return nil, errs.Newf(errs.UnknownMarket, "The price feed does not know %s.", symbol)
		case status != 0:
			return nil, errs.Newf(errs.QuoteUnavailable, "No signed price for %s: %s", symbol, msg)
		}
		return nil, err
	}
	return &q, nil
}

// HistoryPosition is one position from /api/futures/positions?wallet= (indexed by the DEX).
type HistoryPosition struct {
	ID          int64   `json:"id"`
	Contract    string  `json:"contract"`
	Router      *string `json:"router"`
	Symbol      string  `json:"symbol"`
	Base        string  `json:"base"`
	MarketID    int64   `json:"marketId"`
	IsLong      bool    `json:"isLong"`
	Margin      string  `json:"margin"`
	Notional    string  `json:"notional"`
	Leverage    int64   `json:"leverage"`
	EntryPrice  string  `json:"entryPrice"`
	OpenFee     string  `json:"openFee"`
	Liquidation string  `json:"liquidationPrice"`
	OpenedAt    string  `json:"openedAt"`
	OpenTx      string  `json:"openTx"`
	Status      string  `json:"status"`
	ExitPrice   *string `json:"exitPrice"`
	PnL         *string `json:"pnl"`
	Funding     *string `json:"funding"`
	CloseFee    *string `json:"closeFee"`
	Payout      *string `json:"payout"`
	ClosedAt    *string `json:"closedAt"`
	CloseTx     *string `json:"closeTx"`
	ClosedBy    *string `json:"closedBy"`
	TakeProfit  *string `json:"takeProfit"`
	StopLoss    *string `json:"stopLoss"`
	Reductions  []struct {
		Seq       int64  `json:"seq"`
		At        string `json:"at"`
		Tx        string `json:"tx"`
		ExitPrice string `json:"exitPrice"`
		Payout    string `json:"payout"`
		PnL       string `json:"pnl"`
		Fee       string `json:"fee"`
	} `json:"reductions"`
}

// Positions returns the newest positions of a wallet (open and closed, max 100) as indexed by the DEX.
func (c *Client) Positions(ctx context.Context, wallet string) ([]HistoryPosition, error) {
	var r struct {
		Positions []HistoryPosition `json:"positions"`
	}
	if err := c.get(ctx, "/api/futures/positions?wallet="+strings.ToLower(wallet), 0, &r); err != nil {
		return nil, err
	}
	return r.Positions, nil
}

// HistoryOrder is one limit order from /api/futures/orders?wallet=.
type HistoryOrder struct {
	OrderID    int64   `json:"orderId"`
	Router     string  `json:"router"`
	Symbol     string  `json:"symbol"`
	IsLong     bool    `json:"isLong"`
	Margin     string  `json:"margin"`
	Leverage   int64   `json:"leverage"`
	LimitPrice string  `json:"limitPrice"`
	MaxCost    string  `json:"maxCost"`
	ExpiresAt  *string `json:"expiresAt"`
	Status     string  `json:"status"`
	PlacedAt   *string `json:"placedAt"`
	PlaceTx    string  `json:"placeTx"`
	FillTx     *string `json:"fillTx"`
	FillPrice  *string `json:"fillPrice"`
	PositionID *int64  `json:"positionId"`
	RejectText *string `json:"rejectText"`
}

// Orders returns the newest limit orders of a wallet as indexed by the DEX.
func (c *Client) Orders(ctx context.Context, wallet string) ([]HistoryOrder, error) {
	var r struct {
		Orders []HistoryOrder `json:"orders"`
	}
	if err := c.get(ctx, "/api/futures/orders?wallet="+strings.ToLower(wallet), 0, &r); err != nil {
		return nil, err
	}
	return r.Orders, nil
}

// ---------------------------------------------------------------- spot

// SpotMarket is one row of /api/spot-markets.
type SpotMarket struct {
	Symbol        string   `json:"symbol"`
	Name          string   `json:"name"`
	Display       string   `json:"display"`
	Tier          string   `json:"tier"`
	Token         string   `json:"token"`
	Pool          string   `json:"pool"`
	Price         *float64 `json:"price"`
	ReferencePrc  *float64 `json:"referencePrice"`
	Change24hPct  *float64 `json:"change24hPct"`
	Volume24h     float64  `json:"volume24hQuote"`
	Trades24h     int64    `json:"trades24h"`
	LiquidityUsdt *float64 `json:"liquidityUsdt"`
	FeedOK        bool     `json:"feedOk"`
	At            *string  `json:"at"`
}

// SpotMarkets is /api/spot-markets.
type SpotMarkets struct {
	Router  string       `json:"router"`
	Quote   string       `json:"quote"`
	Count   int          `json:"count"`
	Markets []SpotMarket `json:"markets"`
}

// SpotMarkets returns every spot market (about 1 400; cached 5 s).
func (c *Client) SpotMarkets(ctx context.Context) (*SpotMarkets, error) {
	var out SpotMarkets
	if err := c.get(ctx, "/api/spot-markets", 5*time.Second, &out); err != nil {
		return nil, err
	}
	if len(out.Markets) == 0 {
		return nil, errs.New(errs.APIUnavailable, "The spot market list is empty right now.").WithHint("Retry in a few seconds.")
	}
	return &out, nil
}

// SpotMarketDetail returns one market with its live reference price (never cached) and the server time.
func (c *Client) SpotMarketDetail(ctx context.Context, base string) (*SpotMarket, time.Time, error) {
	var out struct {
		Router     string     `json:"router"`
		Market     SpotMarket `json:"market"`
		ServerTime string     `json:"serverTime"`
	}
	if err := c.get(ctx, "/api/spot-markets?symbol="+url.QueryEscape(base), 0, &out); err != nil {
		if status, msg := StatusOf(err); status == http.StatusNotFound {
			if strings.Contains(msg, "ELN") {
				return nil, time.Time{}, errs.New(errs.ElnNotTradable, msg)
			}
			return nil, time.Time{}, errs.Newf(errs.UnknownMarket, "There is no spot market %q.", base)
		}
		return nil, time.Time{}, err
	}
	st, err := time.Parse(time.RFC3339Nano, out.ServerTime)
	if err != nil {
		st = time.Now()
	}
	return &out.Market, st, nil
}

// WrappedAsset is one entry of /api/wrapped-assets.
type WrappedAsset struct {
	Base           string `json:"base"`
	Symbol         string `json:"symbol"`
	Name           string `json:"name"`
	UnderlyingName string `json:"underlyingName"`
	Token          string `json:"token"`
	Decimals       int    `json:"decimals"`
}

// WrappedAssets is /api/wrapped-assets.
type WrappedAssets struct {
	Treasury string         `json:"treasury"`
	Assets   []WrappedAsset `json:"assets"`
	Extended []WrappedAsset `json:"extended"`
}

// WrappedAssets returns every wrapped token issued by Elyon (cached 10 min).
func (c *Client) WrappedAssets(ctx context.Context) (*WrappedAssets, error) {
	var out WrappedAssets
	if err := c.get(ctx, "/api/wrapped-assets", 10*time.Minute, &out); err != nil {
		return nil, err
	}
	return &out, nil
}

// Deployment is /deployments/55452773.json (the website's source for router, factory and WELN).
type Deployment struct {
	ChainID       int64  `json:"chainId"`
	Status        string `json:"status"`
	Factory       string `json:"factory"`
	Router        string `json:"router"`
	WrappedNative string `json:"wrappedNative"`
}

// Deployment returns the spot deployment manifest (cached 10 min).
func (c *Client) Deployment(ctx context.Context) (*Deployment, error) {
	var out Deployment
	if err := c.get(ctx, "/deployments/55452773.json", 10*time.Minute, &out); err != nil {
		return nil, err
	}
	return &out, nil
}

// TokenListEntry is one token of /tokenlist.json (the previous generation of reviewed tokens).
type TokenListEntry struct {
	Address  string `json:"address"`
	Symbol   string `json:"symbol"`
	Name     string `json:"name"`
	Decimals int    `json:"decimals"`
	ChainID  int64  `json:"chainId"`
}

// TokenList returns /tokenlist.json (cached 10 min).
func (c *Client) TokenList(ctx context.Context) ([]TokenListEntry, error) {
	var out struct {
		Tokens []TokenListEntry `json:"tokens"`
	}
	if err := c.get(ctx, "/tokenlist.json", 10*time.Minute, &out); err != nil {
		return nil, err
	}
	return out.Tokens, nil
}

// Health pings the API (used by `elyon status`).
func (c *Client) Health(ctx context.Context) (time.Duration, error) {
	start := time.Now()
	var out map[string]any
	err := c.get(ctx, "/api/v1/health", 0, &out)
	return time.Since(start), err
}
