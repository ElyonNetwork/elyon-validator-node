package cli

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"strings"
	"time"

	"github.com/elyon-chain/elyon-bot/internal/apitoken"
	"github.com/elyon-chain/elyon-bot/internal/app"
	"github.com/elyon-chain/elyon-bot/internal/errs"
	"github.com/elyon-chain/elyon-bot/internal/keystore"
	"github.com/elyon-chain/elyon-bot/internal/version"
)

// daemonInfo is written by `elyon serve` to daemon.json in the home so one-shot commands can find it.
type daemonInfo struct {
	URL     string    `json:"url"`
	PID     int       `json:"pid"`
	Started time.Time `json:"started"`
}

func daemonFile(home string) string { return filepath.Join(home, "daemon.json") }

func writeDaemonInfo(home, listen string) {
	host, port, _ := net.SplitHostPort(listen)
	if host == "" || host == "0.0.0.0" || host == "::" {
		host = "127.0.0.1"
	}
	b, _ := json.Marshal(daemonInfo{URL: "http://" + net.JoinHostPort(host, port), PID: os.Getpid(), Started: time.Now().UTC()})
	_ = keystore.WriteFileAtomic(daemonFile(home), b, false)
}

type remote struct {
	url   string
	token string
	hc    *http.Client
}

// findDaemon returns the running daemon of this home, or nil.
func findDaemon(a *app.App) *remote {
	b, err := os.ReadFile(daemonFile(a.Home))
	if err != nil {
		return nil
	}
	var d daemonInfo
	if json.Unmarshal(b, &d) != nil || !strings.HasPrefix(d.URL, "http://") {
		return nil
	}
	// The CLI sends the API token (and, for a transfer, the password) to this URL: only ever to this machine.
	if u, err := url.Parse(d.URL); err != nil || !isLoopbackHost(u.Hostname()) {
		return nil
	}
	tok, err := apitoken.Load(a.Home)
	if err != nil {
		return nil
	}
	r := &remote{url: d.URL, token: tok, hc: &http.Client{Timeout: 31 * time.Minute}}
	ctx, cancel := context.WithTimeout(context.Background(), 700*time.Millisecond)
	defer cancel()
	req, _ := http.NewRequestWithContext(ctx, http.MethodGet, d.URL+"/v1/health", nil)
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		return nil
	}
	defer resp.Body.Close()
	var h struct {
		OK      bool   `json:"ok"`
		Service string `json:"service"`
	}
	if json.NewDecoder(resp.Body).Decode(&h) != nil || !h.OK || h.Service != "elyon" {
		return nil
	}
	return r
}

// call sends one command to the daemon and returns its envelope.
func (r *remote) call(path string, params app.Params) (*app.Envelope, error) {
	body, _ := json.Marshal(params)
	req, _ := http.NewRequest(http.MethodPost, r.url+path, bytes.NewReader(body))
	req.Header.Set("Authorization", "Bearer "+r.token)
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("User-Agent", version.UserAgent()+" (cli)")
	resp, err := r.hc.Do(req)
	if err != nil {
		return nil, errs.Newf(errs.Internal, "The elyon daemon at %s did not answer: %v", r.url, err)
	}
	defer resp.Body.Close()
	raw, _ := io.ReadAll(io.LimitReader(resp.Body, 32<<20))
	var env app.Envelope
	if err := json.Unmarshal(raw, &env); err != nil {
		return nil, errs.Newf(errs.Internal, "Unexpected answer from the daemon (HTTP %d).", resp.StatusCode)
	}
	return &env, nil
}

func (r *remote) batch(raw []byte) (*app.BatchEnvelope, error) {
	req, _ := http.NewRequest(http.MethodPost, r.url+"/v1/batch", bytes.NewReader(raw))
	req.Header.Set("Authorization", "Bearer "+r.token)
	req.Header.Set("Content-Type", "application/json")
	resp, err := r.hc.Do(req)
	if err != nil {
		return nil, errs.Newf(errs.Internal, "The elyon daemon did not answer: %v", err)
	}
	defer resp.Body.Close()
	var env app.BatchEnvelope
	if err := json.NewDecoder(resp.Body).Decode(&env); err != nil {
		var single app.Envelope
		return nil, errs.Newf(errs.Internal, "Unexpected answer from the daemon (HTTP %d) %v", resp.StatusCode, single.Error)
	}
	return &env, nil
}

func (r *remote) String() string { return fmt.Sprintf("daemon %s", r.url) }

func isLoopbackHost(h string) bool {
	if h == "localhost" {
		return true
	}
	ip := net.ParseIP(h)
	return ip != nil && ip.IsLoopback()
}
