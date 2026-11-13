// Package guard decides whether a transfer out of the wallet is allowed:
//
//   - the destination must be on the allowlist (adding to it needs the password), OR the request must carry the
//     wallet password;
//   - and, if the user set a daily limit for the token, the transfers of the last 24 hours plus this one must stay
//     within it.
//
// Trading commands never move funds to other addresses (swap outputs and futures payouts always go to the wallet
// itself), so `wallet send` is the only way out and the only command guarded here.
package guard

import (
	"encoding/json"
	"math/big"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"time"

	"github.com/ethereum/go-ethereum/common"

	"github.com/elyon-chain/elyon-bot/internal/amount"
	"github.com/elyon-chain/elyon-bot/internal/errs"
	"github.com/elyon-chain/elyon-bot/internal/keystore"
)

// Window is the rolling period of daily limits.
const Window = 24 * time.Hour

// Request is one transfer to authorize.
type Request struct {
	To         common.Address
	Token      string // lower-case address or "native"
	Symbol     string
	Decimals   int
	Amount     *big.Int
	PasswordOK bool // the wallet password was supplied with this request and verified
}

// Allowed reports whether an address is on the allowlist.
func Allowed(list []keystore.AllowEntry, a common.Address) bool {
	for _, e := range list {
		if common.HexToAddress(e.Address) == a {
			return true
		}
	}
	return false
}

// LimitFor returns the daily limit for a token (nil = no limit).
func LimitFor(limits []keystore.DailyLimit, token string) *keystore.DailyLimit {
	for i := range limits {
		if strings.EqualFold(limits[i].Token, token) {
			return &limits[i]
		}
	}
	return nil
}

// Authorize applies the rules. spent is what was sent of this token in the last 24 hours.
func Authorize(r Request, allow []keystore.AllowEntry, limits []keystore.DailyLimit, spent *big.Int) error {
	if !r.PasswordOK && !Allowed(allow, r.To) {
		return errs.Newf(errs.TransferNotAllowed, "Sending to %s needs your wallet password, because this address is not on your approved list.", r.To.Hex()).
			WithHint("Give the password with this request, or approve the address once: `elyon wallet allow " + r.To.Hex() + "` (asks for the password).")
	}
	if l := LimitFor(limits, r.Token); l != nil {
		max, ok := new(big.Int).SetString(l.Amount, 10)
		if !ok {
			return errs.New(errs.WalletTampered, "The daily limit setting is damaged.")
		}
		total := new(big.Int).Add(spent, r.Amount)
		if total.Cmp(max) > 0 {
			left := new(big.Int).Sub(max, spent)
			if left.Sign() < 0 {
				left.SetInt64(0)
			}
			return errs.Newf(errs.DailyLimit, "This would exceed your daily limit of %s %s: %s %s were already sent in the last 24 hours, %s %s are left.",
				amount.Format(max, l.Decimals), l.Symbol, amount.Format(spent, l.Decimals), l.Symbol, amount.Format(left, l.Decimals), l.Symbol).
				WithHint("Wait, or change the limit with `elyon wallet limit <amount> " + l.Symbol + "` (asks for the password).")
		}
	}
	return nil
}

// Ledger remembers recent transfers (transfers.json in the elyon home, plus memory, so deleting the file while
// the daemon runs does not reset its count).
type Ledger struct {
	mu      sync.Mutex
	path    string
	Entries []Entry `json:"entries"`
}

// Entry is one sent transfer.
type Entry struct {
	Time   time.Time `json:"time"`
	Token  string    `json:"token"`
	Amount string    `json:"amount"`
	To     string    `json:"to"`
	Tx     string    `json:"tx"`
}

// LoadLedger reads transfers.json (a missing or damaged file starts empty).
func LoadLedger(home string) *Ledger {
	l := &Ledger{path: filepath.Join(home, "transfers.json")}
	if b, err := os.ReadFile(l.path); err == nil {
		_ = json.Unmarshal(b, l)
	}
	return l
}

// Spent sums the transfers of token in the window before now.
func (l *Ledger) Spent(token string, now time.Time) *big.Int {
	l.mu.Lock()
	defer l.mu.Unlock()
	sum := new(big.Int)
	for _, e := range l.Entries {
		if strings.EqualFold(e.Token, token) && now.Sub(e.Time) < Window {
			if v, ok := new(big.Int).SetString(e.Amount, 10); ok {
				sum.Add(sum, v)
			}
		}
	}
	return sum
}

// Merge adds entries from disk that memory does not have (another elyon process may have sent meanwhile).
func (l *Ledger) Merge() {
	other := LoadLedger(filepath.Dir(l.path))
	l.mu.Lock()
	defer l.mu.Unlock()
	have := map[string]bool{}
	for _, e := range l.Entries {
		have[e.Tx] = true
	}
	for _, e := range other.Entries {
		if !have[e.Tx] {
			l.Entries = append(l.Entries, e)
		}
	}
}

// Record adds a transfer and saves the file (entries older than 7 days are dropped).
func (l *Ledger) Record(e Entry) error {
	l.mu.Lock()
	defer l.mu.Unlock()
	keep := l.Entries[:0]
	for _, old := range l.Entries {
		if e.Time.Sub(old.Time) < 7*Window {
			keep = append(keep, old)
		}
	}
	l.Entries = append(keep, e)
	b, err := json.MarshalIndent(l, "", "  ")
	if err != nil {
		return err
	}
	return keystore.WriteFileAtomic(l.path, append(b, '\n'), false)
}
