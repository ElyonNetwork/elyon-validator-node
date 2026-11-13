// Package registry is the built-in list of Elyon wrapped tokens (a snapshot of
// https://dex.elyon.network/api/wrapped-assets taken at release time, regenerated with tools/update-registry).
//
// It is a safety net: when the DEX API maps a known ticker to a different token contract than this list,
// elyon-bot refuses to trade it, so a compromised or mistaken API cannot make it buy a look-alike token.
// Tokens listed after the release are accepted from the API (and marked "new").
package registry

import (
	_ "embed"
	"encoding/json"
	"strings"
	"sync"

	"github.com/ethereum/go-ethereum/common"
)

//go:embed tokens.json
var tokensJSON []byte

// Token is one wrapped asset.
type Token struct {
	Base     string `json:"base"`
	Symbol   string `json:"symbol"`
	Name     string `json:"name"`
	Address  string `json:"token"`
	Decimals int    `json:"decimals"`
	Tier     string `json:"tier"` // core, extended, usdt
}

// Addr returns the token address.
func (t Token) Addr() common.Address { return common.HexToAddress(t.Address) }

type snapshot struct {
	Source      string  `json:"source"`
	GeneratedAt string  `json:"generated_at"`
	Tokens      []Token `json:"tokens"`
}

var (
	once    sync.Once
	snap    snapshot
	byBase  map[string]Token
	byToken map[common.Address]Token
)

func load() {
	once.Do(func() {
		if err := json.Unmarshal(tokensJSON, &snap); err != nil {
			panic("embedded token registry: " + err.Error())
		}
		byBase = map[string]Token{}
		byToken = map[common.Address]Token{}
		for _, t := range snap.Tokens {
			byBase[strings.ToUpper(t.Base)] = t
			byToken[t.Addr()] = t
		}
	})
}

// All returns the built-in tokens (core, extended and wUSDT).
func All() []Token { load(); return snap.Tokens }

// GeneratedAt is the snapshot time.
func GeneratedAt() string { load(); return snap.GeneratedAt }

// ByBase looks a token up by its underlying ticker (BTC → wBTC).
func ByBase(base string) (Token, bool) { load(); t, ok := byBase[strings.ToUpper(base)]; return t, ok }

// ByAddress looks a token up by contract address.
func ByAddress(a common.Address) (Token, bool) { load(); t, ok := byToken[a]; return t, ok }

// Verdict of a cross-check.
type Verdict int

const (
	// Known: the API agrees with the built-in list.
	Known Verdict = iota
	// New: the ticker is not in the built-in list (listed after this release).
	New
	// Mismatch: the API maps a known ticker to another contract: never trade it.
	Mismatch
)

// Check compares an API (base, token) pair with the built-in list.
func Check(base string, token common.Address) Verdict {
	load()
	t, ok := byBase[strings.ToUpper(base)]
	if !ok {
		if _, known := byToken[token]; known {
			return Mismatch // a known contract under another ticker
		}
		return New
	}
	if t.Addr() != token {
		return Mismatch
	}
	return Known
}
