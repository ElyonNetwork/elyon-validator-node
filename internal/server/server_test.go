package server

import (
	"encoding/json"
	"io"
	"log"
	"net/http"
	"net/http/httptest"
	"os"
	"strings"
	"testing"
	"time"

	"github.com/elyon-chain/elyon-bot/internal/apitoken"
	"github.com/elyon-chain/elyon-bot/internal/app"
	"github.com/elyon-chain/elyon-bot/internal/config"
	"github.com/elyon-chain/elyon-bot/internal/keystore"
)

func newTestServer(t *testing.T, listen string, allow []string, rate float64) (*Server, string) {
	t.Helper()
	home := t.TempDir()
	tok, _, err := apitoken.Ensure(home)
	if err != nil {
		t.Fatal(err)
	}
	a := app.New(home, config.Default(), app.ModeDaemon)
	s, err := New(a, Options{Listen: listen, AllowIP: allow, RateLimit: rate, Logger: log.New(io.Discard, "", 0)})
	if err != nil {
		t.Fatal(err)
	}
	return s, tok
}

type resp struct {
	status int
	env    app.Envelope
	raw    string
}

func do(t *testing.T, h http.Handler, method, path, token, body string, mut ...func(*http.Request)) resp {
	t.Helper()
	var rd io.Reader
	if body != "" {
		rd = strings.NewReader(body)
	}
	req := httptest.NewRequest(method, path, rd)
	req.RemoteAddr = "127.0.0.1:50000"
	req.Host = "127.0.0.1:7457"
	if body != "" {
		req.Header.Set("Content-Type", "application/json")
	}
	if token != "" {
		req.Header.Set("Authorization", "Bearer "+token)
	}
	for _, m := range mut {
		m(req)
	}
	w := httptest.NewRecorder()
	h.ServeHTTP(w, req)
	var env app.Envelope
	_ = json.Unmarshal(w.Body.Bytes(), &env)
	return resp{w.Code, env, w.Body.String()}
}

func code(r resp) string {
	if r.env.Error == nil {
		return ""
	}
	return r.env.Error.Code
}

func TestAuth(t *testing.T) {
	s, tok := newTestServer(t, "127.0.0.1:7457", nil, 1000)
	h := s.Handler()

	if r := do(t, h, "GET", "/v1/health", "", ""); r.status != 200 || !strings.Contains(r.raw, `"ok": true`) {
		t.Fatalf("health without token: %d %s", r.status, r.raw)
	}
	if strings.Contains(do(t, h, "GET", "/v1/health", "", "").raw, "0x") {
		t.Fatal("health must not reveal the address")
	}
	if r := do(t, h, "GET", "/v1/version", "", ""); r.status != 401 || code(r) != "UNAUTHORIZED" {
		t.Fatalf("missing token: %d %s", r.status, r.raw)
	}
	if r := do(t, h, "GET", "/v1/version", tok+"x", ""); r.status != 401 || code(r) != "UNAUTHORIZED" {
		t.Fatalf("wrong token: %d %s", r.status, r.raw)
	}
	if r := do(t, h, "GET", "/v1/version", "", "", func(q *http.Request) { q.Header.Set("Authorization", "Basic "+tok) }); r.status != 401 {
		t.Fatalf("non-bearer scheme accepted: %d", r.status)
	}
	if r := do(t, h, "GET", "/v1/version", tok, ""); r.status != 200 || !r.env.OK || r.env.Command != "version" {
		t.Fatalf("good token: %d %s", r.status, r.raw)
	}
	if r := do(t, h, "POST", "/v1/version", tok, "{}"); r.status != 200 || !r.env.OK {
		t.Fatalf("POST read-only: %d %s", r.status, r.raw)
	}
}

func TestTokenRotationAndBruteForceLimit(t *testing.T) {
	s, tok := newTestServer(t, "127.0.0.1:7457", nil, 1000)
	h := s.Handler()
	if r := do(t, h, "GET", "/v1/version", tok, ""); r.status != 200 {
		t.Fatal("initial token refused")
	}
	time.Sleep(20 * time.Millisecond) // a new mtime
	newTok, err := apitoken.Rotate(s.App.Home)
	if err != nil {
		t.Fatal(err)
	}
	_ = os.Chtimes(apitoken.Path(s.App.Home), time.Now().Add(time.Second), time.Now().Add(time.Second))
	if r := do(t, h, "GET", "/v1/version", tok, ""); r.status != 401 {
		t.Fatalf("old token still accepted after rotation: %d", r.status)
	}
	if r := do(t, h, "GET", "/v1/version", newTok, ""); r.status != 200 {
		t.Fatalf("new token refused: %d %s", r.status, r.raw)
	}
	// Wrong tokens are throttled: after a few failures even more guesses get 429.
	got429 := false
	for i := 0; i < 8; i++ {
		if r := do(t, h, "GET", "/v1/version", "elyon_wrongwrongwrongwrongwrongwrongwrongwrongwrong", ""); r.status == 429 {
			got429 = true
		}
	}
	if !got429 {
		t.Fatal("token guessing is not rate limited")
	}
}

func TestNetworkGuards(t *testing.T) {
	s, tok := newTestServer(t, "127.0.0.1:7457", nil, 1000)
	h := s.Handler()
	if r := do(t, h, "GET", "/v1/version", tok, "", func(q *http.Request) { q.Host = "evil.example:7457" }); r.status != 403 {
		t.Fatalf("DNS-rebinding host accepted: %d", r.status)
	}
	if r := do(t, h, "GET", "/v1/version", tok, "", func(q *http.Request) { q.Header.Set("Origin", "https://evil.example") }); r.status != 403 {
		t.Fatalf("foreign origin accepted: %d", r.status)
	}
	if r := do(t, h, "GET", "/v1/version", tok, "", func(q *http.Request) { q.RemoteAddr = "192.168.1.9:4000" }); r.status != 403 {
		t.Fatalf("remote client accepted on loopback bind: %d", r.status)
	}
	if r := do(t, h, "GET", "/v1/version", tok, "", func(q *http.Request) { q.Host = "localhost:7457" }); r.status != 200 {
		t.Fatalf("localhost host refused: %d", r.status)
	}

	// Docker-style: bound to all interfaces with an allowlist.
	s2, tok2 := newTestServer(t, "0.0.0.0:7457", []string{"172.17.0.0/16", "10.0.0.7"}, 1000)
	h2 := s2.Handler()
	if r := do(t, h2, "GET", "/v1/version", tok2, "", func(q *http.Request) { q.RemoteAddr = "172.17.0.1:5000"; q.Host = "elyon:7457" }); r.status != 200 {
		t.Fatalf("allowed bridge client refused: %d %s", r.status, r.raw)
	}
	if r := do(t, h2, "GET", "/v1/version", tok2, "", func(q *http.Request) { q.RemoteAddr = "10.0.0.7:5000" }); r.status != 200 {
		t.Fatalf("allowed single IP refused: %d", r.status)
	}
	if r := do(t, h2, "GET", "/v1/version", tok2, "", func(q *http.Request) { q.RemoteAddr = "203.0.113.5:5000" }); r.status != 403 || code(r) != "FORBIDDEN" {
		t.Fatalf("outside client accepted: %d", r.status)
	}
	if _, err := New(s.App, Options{Listen: "0.0.0.0:1", AllowIP: []string{"not-an-ip"}}); err == nil {
		t.Fatal("bad allow-ip accepted")
	}
}

func TestRateLimit(t *testing.T) {
	s, tok := newTestServer(t, "127.0.0.1:7457", nil, 1) // 1 req/s, burst 2
	h := s.Handler()
	statuses := []int{}
	for i := 0; i < 4; i++ {
		statuses = append(statuses, do(t, h, "GET", "/v1/version", tok, "").status)
	}
	if statuses[0] != 200 || statuses[1] != 200 || statuses[3] != 429 {
		t.Fatalf("rate limit statuses %v", statuses)
	}
}

func TestRequestValidation(t *testing.T) {
	s, tok := newTestServer(t, "127.0.0.1:7457", nil, 1000)
	h := s.Handler()
	if r := do(t, h, "GET", "/v1/futures/open?side=long", tok, ""); r.status != 405 {
		t.Fatalf("GET on a trading command: %d", r.status)
	}
	if r := do(t, h, "POST", "/v1/version", tok, "{}", func(q *http.Request) { q.Header.Set("Content-Type", "text/plain") }); r.status != 400 {
		t.Fatalf("non-JSON body accepted: %d", r.status)
	}
	if r := do(t, h, "POST", "/v1/version", tok, `{"levrage": 5}`); r.status != 400 || code(r) != "INVALID_INPUT" || !strings.Contains(r.env.Error.Message, "levrage") {
		t.Fatalf("unknown field: %d %s", r.status, r.raw)
	}
	if r := do(t, h, "POST", "/v1/version", tok, `{"x": {"nested": 1}}`); r.status != 400 {
		t.Fatalf("nested value accepted: %d", r.status)
	}
	if r := do(t, h, "POST", "/v1/wallet/backup", tok, "{}"); r.status != 403 || code(r) != "NOT_AVAILABLE_OVER_HTTP" {
		t.Fatalf("interactive command over HTTP: %d %s", r.status, r.raw)
	}
	if r := do(t, h, "POST", "/v1/password/change", tok, "{}"); r.status != 403 {
		t.Fatalf("password change over HTTP: %d", r.status)
	}
	if r := do(t, h, "POST", "/v1/no/such/thing", tok, "{}"); r.status != 404 || code(r) != "UNKNOWN_COMMAND" {
		t.Fatalf("unknown command: %d", r.status)
	}
	if r := do(t, h, "POST", "/v1/futures/open", tok, `{"side":"long"}`); r.status != 409 || code(r) != "WALLET_MISSING" {
		t.Fatalf("trading without a wallet: %d %s", r.status, r.raw)
	}
	big := `{"x":"` + strings.Repeat("a", 300<<10) + `"}`
	if r := do(t, h, "POST", "/v1/version", tok, big); r.status != 400 {
		t.Fatalf("oversized body: %d", r.status)
	}
}

func TestLockedWalletAndPasswordGates(t *testing.T) {
	keystore.ScryptN = 1 << 14
	s, tok := newTestServer(t, "127.0.0.1:7457", nil, 1000)
	if _, err := keystore.ImportMnemonic(s.App.Home, "test test test test test test test test test test test junk", []byte("a long test passphrase"), time.Now()); err != nil {
		t.Fatal(err)
	}
	h := s.Handler()
	// Daemon not unlocked: trading is refused with a clear code.
	if r := do(t, h, "POST", "/v1/futures/close", tok, `{"id":"1"}`); r.status != 409 || code(r) != "WALLET_LOCKED" {
		t.Fatalf("locked: %d %s", r.status, r.raw)
	}
	// Approving a transfer destination requires the password in the request.
	if r := do(t, h, "POST", "/v1/wallet/allow", tok, `{"address":"0x0E0bB1BDEc7248eBac6eFBE624ceAEd86bda3e27"}`); r.status != 401 || code(r) != "PASSWORD_REQUIRED" {
		t.Fatalf("allow without password: %d %s", r.status, r.raw)
	}
	if r := do(t, h, "POST", "/v1/wallet/allow", tok, `{"address":"0x0E0bB1BDEc7248eBac6eFBE624ceAEd86bda3e27","password":"wrong password here"}`); r.status != 401 || code(r) != "WRONG_PASSWORD" {
		t.Fatalf("allow with wrong password: %d %s", r.status, r.raw)
	}
	if r := do(t, h, "POST", "/v1/wallet/allow", tok, `{"address":"0x0E0bB1BDEc7248eBac6eFBE624ceAEd86bda3e27","password":"a long test passphrase","label":"dex"}`); r.status != 200 || !r.env.OK {
		t.Fatalf("allow with password: %d %s", r.status, r.raw)
	}
	if r := do(t, h, "GET", "/v1/wallet/allowed", tok, ""); !strings.Contains(r.raw, "0x0E0bB1BDEc7248eBac6eFBE624ceAEd86bda3e27") {
		t.Fatalf("allowlist not saved: %s", r.raw)
	}
	// The audit log records the call without the password.
	b, _ := os.ReadFile(s.App.Audit.Path())
	if !strings.Contains(string(b), "wallet.allow") || strings.Contains(string(b), "a long test passphrase") || strings.Contains(string(b), "wrong password here") {
		t.Fatalf("audit log: %s", b)
	}
	// Unlock with a wrong password, then the right one.
	if r := do(t, h, "POST", "/v1/unlock", tok, `{"password":"nope nope nope"}`); code(r) != "WRONG_PASSWORD" {
		t.Fatalf("unlock wrong: %s", r.raw)
	}
	if r := do(t, h, "POST", "/v1/unlock", tok, `{"password":"a long test passphrase"}`); !r.env.OK || !s.App.Session.Unlocked() {
		t.Fatalf("unlock: %s", r.raw)
	}
	if r := do(t, h, "POST", "/v1/lock", tok, `{}`); !r.env.OK || s.App.Session.Unlocked() {
		t.Fatalf("lock: %s", r.raw)
	}
	// Five wrong passwords block password checks.
	for i := 0; i < 5; i++ {
		do(t, h, "POST", "/v1/unlock", tok, `{"password":"guess guess guess"}`)
	}
	if r := do(t, h, "POST", "/v1/unlock", tok, `{"password":"a long test passphrase"}`); code(r) != "TOO_MANY_PASSWORD_ATTEMPTS" {
		t.Fatalf("password brute force not blocked: %s", r.raw)
	}
}

func TestBatch(t *testing.T) {
	s, tok := newTestServer(t, "127.0.0.1:7457", nil, 1000)
	h := s.Handler()
	body := `{"stop_on_error": true, "commands": [{"command": "version"}, {"command": "nope"}, {"command": "version"}]}`
	r := do(t, h, "POST", "/v1/batch", tok, body)
	var env app.BatchEnvelope
	if err := json.Unmarshal([]byte(r.raw), &env); err != nil || r.status != 200 {
		t.Fatalf("batch: %d %s", r.status, r.raw)
	}
	if env.OK || len(env.Steps) != 3 || !env.Steps[0].OK || env.Steps[1].OK || env.Steps[1].Error.Code != "UNKNOWN_COMMAND" || !env.Steps[2].Skipped {
		t.Fatalf("stop_on_error semantics: %+v", env)
	}
	body = `{"stop_on_error": false, "commands": [{"command": "nope"}, {"command": "version"}, {"command": "wallet backup"}]}`
	_ = json.Unmarshal([]byte(do(t, h, "POST", "/v1/batch", tok, body).raw), &env)
	if env.OK || env.Steps[1].Skipped || !env.Steps[1].OK || env.Steps[2].Error.Code != "NOT_AVAILABLE_OVER_HTTP" {
		t.Fatalf("continue semantics: %+v", env)
	}
	if r := do(t, h, "POST", "/v1/batch", tok, `{"commands": []}`); r.status != 400 {
		t.Fatalf("empty batch: %d", r.status)
	}
	if r := do(t, h, "POST", "/v1/batch", "", body); r.status != 401 {
		t.Fatalf("batch without token: %d", r.status)
	}
}

func TestConstantTimeEqual(t *testing.T) {
	if !apitoken.Equal("elyon_abc", "elyon_abc") || apitoken.Equal("elyon_abc", "elyon_abd") || apitoken.Equal("", "") || apitoken.Equal("x", "") {
		t.Fatal("token comparison")
	}
	tok, _ := apitoken.Generate()
	if !strings.HasPrefix(tok, "elyon_") || len(tok) < 46 {
		t.Fatalf("token format %q", tok)
	}
}
