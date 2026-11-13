// Minimal Elyon bot in Go (standard library only).
// Start the client first:  elyon serve
// Then:                    ELYON_TOKEN=$(elyon api-token show) go run .
// Set ELYON_TRADE=1 to really open and close a tiny position (1 wUSDT margin, 2x).
package main

import (
	"bytes"
	"encoding/json"
	"fmt"
	"log"
	"net/http"
	"os"
	"time"
)

type answer struct {
	OK     bool            `json:"ok"`
	Result json.RawMessage `json:"result"`
	Error  *struct {
		Code, Message, Hint string
	} `json:"error"`
}

var (
	base   = env("ELYON_URL", "http://127.0.0.1:7457")
	token  = os.Getenv("ELYON_TOKEN")
	client = &http.Client{Timeout: 10 * time.Minute}
)

func env(k, d string) string {
	if v := os.Getenv(k); v != "" {
		return v
	}
	return d
}

// call sends GET (body == nil) or POST JSON and decodes the answer's result into out.
func call(path string, body any, out any) (*answer, error) {
	method, rd := http.MethodGet, (*bytes.Reader)(nil)
	if body != nil {
		b, _ := json.Marshal(body)
		method, rd = http.MethodPost, bytes.NewReader(b)
	}
	var req *http.Request
	if rd != nil {
		req, _ = http.NewRequest(method, base+path, rd)
		req.Header.Set("Content-Type", "application/json")
	} else {
		req, _ = http.NewRequest(method, base+path, nil)
	}
	req.Header.Set("Authorization", "Bearer "+token)
	res, err := client.Do(req)
	if err != nil {
		return nil, err
	}
	defer res.Body.Close()
	var a answer
	if err := json.NewDecoder(res.Body).Decode(&a); err != nil {
		return nil, err
	}
	if !a.OK {
		return &a, fmt.Errorf("elyon error %s: %s %s", a.Error.Code, a.Error.Message, a.Error.Hint)
	}
	if out != nil {
		return &a, json.Unmarshal(a.Result, out)
	}
	return &a, nil
}

func main() {
	if token == "" {
		log.Fatal("Set ELYON_TOKEN (run: elyon api-token show)")
	}
	var status struct {
		Wallet struct{ Address, ELN, WUSDT string } `json:"wallet"`
	}
	if _, err := call("/v1/status", nil, &status); err != nil {
		log.Fatal(err)
	}
	fmt.Println("wallet", status.Wallet.Address, "| ELN", status.Wallet.ELN, "| wUSDT", status.Wallet.WUSDT)

	var price struct {
		Market struct{ Last float64 } `json:"market"`
	}
	if _, err := call("/v1/futures/price?market=BTC", nil, &price); err != nil {
		log.Fatal(err)
	}
	fmt.Println("BTC last price", price.Market.Last)

	if os.Getenv("ELYON_TRADE") == "1" {
		order := map[string]any{"side": "long", "market": "BTC", "margin": "1", "leverage": 2, "stop_loss": fmt.Sprintf("%.0f", price.Market.Last*0.9)}
		var pos struct {
			PositionID uint64 `json:"position_id"`
			EntryPrice string `json:"entry_price"`
		}
		a, err := call("/v1/futures/open", order, &pos)
		if err != nil && a != nil && a.Error.Code == "QUOTE_EXPIRED" {
			_, err = call("/v1/futures/open", order, &pos)
		}
		if err != nil {
			log.Fatal(err)
		}
		fmt.Println("opened position", pos.PositionID, "at", pos.EntryPrice)
		var closed struct{ Payout string }
		if _, err := call("/v1/futures/close", map[string]any{"id": pos.PositionID}, &closed); err != nil {
			log.Fatal(err)
		}
		fmt.Println("closed, paid back", closed.Payout, "wUSDT")
	}

	// Several commands in one request.
	req := map[string]any{"stop_on_error": false, "commands": []map[string]any{
		{"command": "futures price", "params": map[string]any{"market": "ETH"}},
		{"command": "futures positions"},
	}}
	b, _ := json.Marshal(req)
	hr, _ := http.NewRequest(http.MethodPost, base+"/v1/batch", bytes.NewReader(b))
	hr.Header.Set("Authorization", "Bearer "+token)
	hr.Header.Set("Content-Type", "application/json")
	res, err := client.Do(hr)
	if err != nil {
		log.Fatal(err)
	}
	defer res.Body.Close()
	var batch struct {
		OK    bool `json:"ok"`
		Steps []struct {
			Index   int
			Command string
			OK      bool
		} `json:"steps"`
	}
	_ = json.NewDecoder(res.Body).Decode(&batch)
	for _, s := range batch.Steps {
		fmt.Println("batch step", s.Index, s.Command, s.OK)
	}
}
