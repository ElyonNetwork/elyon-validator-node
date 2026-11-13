// Package server is the local HTTP+JSON API of `elyon serve`. Every command of the CLI is available at
// /v1/<words> (POST with a JSON body; read-only commands also with GET and query parameters), plus POST /v1/batch.
//
// Protection, in order: request size limit → client address allowlist → Host check (DNS rebinding) when bound
// to loopback → per-address rate limit → bearer token (constant-time; failed attempts are rate limited more
// strictly) → the command's own checks (wallet locked, password for transfers…). Every command is written to
// the audit log without its secrets.
package server

import (
	"context"
	"crypto/tls"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log"
	"net"
	"net/http"
	"net/url"
	"os"
	"strings"
	"sync"
	"time"

	"golang.org/x/time/rate"

	"github.com/elyon-chain/elyon-bot/internal/apitoken"
	"github.com/elyon-chain/elyon-bot/internal/app"
	"github.com/elyon-chain/elyon-bot/internal/errs"
	"github.com/elyon-chain/elyon-bot/internal/version"
)

// Options configure the server.
type Options struct {
	Listen    string
	AllowIP   []string
	RateLimit float64
	AutoLock  time.Duration
	TLSCert   string
	TLSKey    string
	Logger    *log.Logger
}

// Server is the HTTP API.
type Server struct {
	App  *app.App
	Opts Options

	nets     []*net.IPNet
	loopback bool

	mu        sync.Mutex
	token     string
	tokenMod  time.Time
	limiters  map[string]*rate.Limiter
	failures  map[string]*rate.Limiter
	lastClean time.Time
}

// New validates options and builds a server.
func New(a *app.App, o Options) (*Server, error) {
	s := &Server{App: a, Opts: o, limiters: map[string]*rate.Limiter{}, failures: map[string]*rate.Limiter{}}
	host, _, err := net.SplitHostPort(o.Listen)
	if err != nil {
		return nil, fmt.Errorf("listen address %q must look like 127.0.0.1:7457", o.Listen)
	}
	ip := net.ParseIP(host)
	s.loopback = host == "localhost" || (ip != nil && ip.IsLoopback())
	for _, a := range o.AllowIP {
		n, err := parseNet(a)
		if err != nil {
			return nil, err
		}
		s.nets = append(s.nets, n)
	}
	if s.Opts.RateLimit <= 0 {
		s.Opts.RateLimit = 20
	}
	if s.Opts.Logger == nil {
		s.Opts.Logger = log.New(os.Stderr, "", log.LstdFlags)
	}
	if err := s.reloadToken(); err != nil {
		return nil, err
	}
	return s, nil
}

// Loopback reports whether the server only listens on the local machine.
func (s *Server) Loopback() bool { return s.loopback }

func parseNet(s string) (*net.IPNet, error) {
	s = strings.TrimSpace(s)
	if !strings.Contains(s, "/") {
		ip := net.ParseIP(s)
		if ip == nil {
			return nil, fmt.Errorf("--allow-ip %q is not an IP address or CIDR range", s)
		}
		if ip.To4() != nil {
			s += "/32"
		} else {
			s += "/128"
		}
	}
	_, n, err := net.ParseCIDR(s)
	if err != nil {
		return nil, fmt.Errorf("--allow-ip %q is not an IP address or CIDR range", s)
	}
	return n, nil
}

func (s *Server) reloadToken() error {
	p := apitoken.Path(s.App.Home)
	st, err := os.Stat(p)
	if err != nil {
		return fmt.Errorf("no API token: %w", err)
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.token != "" && st.ModTime().Equal(s.tokenMod) {
		return nil
	}
	t, err := apitoken.Load(s.App.Home)
	if err != nil {
		return err
	}
	s.token, s.tokenMod = t, st.ModTime()
	return nil
}

func (s *Server) currentToken() string {
	_ = s.reloadToken() // picks up `elyon api-token rotate` without a restart
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.token
}

// Handler builds the HTTP handler (exported for tests).
func (s *Server) Handler() http.Handler {
	mux := http.NewServeMux()
	mux.HandleFunc("/v1/health", func(w http.ResponseWriter, r *http.Request) {
		writeJSON(w, http.StatusOK, map[string]any{"ok": true, "service": "elyon", "version": version.Version})
	})
	mux.HandleFunc("/v1/batch", s.authed(s.batch))
	mux.HandleFunc("/v1/", s.authed(s.command))
	mux.HandleFunc("/", func(w http.ResponseWriter, r *http.Request) {
		fail(w, errs.New(errs.UnknownCommand, "Unknown path. Every command lives under /v1/, for example POST /v1/futures/open; GET /v1/commands lists them."))
	})
	return s.guard(mux)
}

// guard applies the network-level protections to every request.
func (s *Server) guard(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		start := time.Now()
		rw := &statusWriter{ResponseWriter: w, status: 200}
		w = rw
		ip := clientIP(r)
		defer func() {
			s.Opts.Logger.Printf("%s %s %s → %d %s (%d ms)", ip, r.Method, r.URL.Path, rw.status, rw.code, time.Since(start).Milliseconds())
		}()
		w.Header().Set("Cache-Control", "no-store")
		w.Header().Set("X-Content-Type-Options", "nosniff")
		if len(s.nets) > 0 && !s.allowed(ip) {
			rw.code = errs.Forbidden
			fail(w, errs.Newf(errs.Forbidden, "Requests from %s are not allowed (see --allow-ip).", ip))
			return
		}
		if len(s.nets) == 0 && s.loopback && !isLoopbackIP(ip) {
			rw.code = errs.Forbidden
			fail(w, errs.New(errs.Forbidden, "Only local requests are allowed."))
			return
		}
		if s.loopback && !hostIsLocal(r.Host) {
			// A web page cannot reach the API through DNS rebinding: its Host header would be its own domain.
			rw.code = errs.Forbidden
			fail(w, errs.New(errs.Forbidden, "Bad Host header: call the API as http://127.0.0.1:<port> or http://localhost:<port>."))
			return
		}
		if r.Header.Get("Origin") != "" && !originIsLocal(r.Header.Get("Origin")) {
			rw.code = errs.Forbidden
			fail(w, errs.New(errs.Forbidden, "Browser requests from other sites are refused."))
			return
		}
		if !s.limiter(ip, false).Allow() {
			rw.code = errs.RateLimited
			w.Header().Set("Retry-After", "1")
			fail(w, errs.New(errs.RateLimited, "Too many requests. Slow down (see --rate)."))
			return
		}
		r.Body = http.MaxBytesReader(w, r.Body, 256<<10)
		next.ServeHTTP(w, r)
	})
}

func (s *Server) allowed(ip string) bool {
	p := net.ParseIP(ip)
	if p == nil {
		return false
	}
	for _, n := range s.nets {
		if n.Contains(p) {
			return true
		}
	}
	return false
}

func isLoopbackIP(ip string) bool { p := net.ParseIP(ip); return p != nil && p.IsLoopback() }

func hostIsLocal(h string) bool {
	host := h
	if hh, _, err := net.SplitHostPort(h); err == nil {
		host = hh
	}
	host = strings.Trim(strings.ToLower(host), "[]")
	if host == "localhost" || strings.HasSuffix(host, ".localhost") {
		return true
	}
	ip := net.ParseIP(host)
	return ip != nil && ip.IsLoopback()
}

func originIsLocal(o string) bool {
	u, err := url.Parse(o)
	return err == nil && hostIsLocal(u.Host)
}

func clientIP(r *http.Request) string {
	host, _, err := net.SplitHostPort(r.RemoteAddr)
	if err != nil {
		return r.RemoteAddr
	}
	return host
}

func (s *Server) limiter(ip string, failure bool) *rate.Limiter {
	s.mu.Lock()
	defer s.mu.Unlock()
	if time.Since(s.lastClean) > 10*time.Minute {
		s.limiters, s.failures, s.lastClean = map[string]*rate.Limiter{}, map[string]*rate.Limiter{}, time.Now()
	}
	m, lim := s.limiters, rate.Limit(s.Opts.RateLimit)
	burst := int(2 * s.Opts.RateLimit)
	if failure {
		m, lim, burst = s.failures, rate.Every(12*time.Second), 5 // 5 wrong tokens, then 1 per 12 s
	}
	l, ok := m[ip]
	if !ok {
		l = rate.NewLimiter(lim, max(burst, 1))
		m[ip] = l
	}
	return l
}

// authed checks the bearer token.
func (s *Server) authed(h func(w http.ResponseWriter, r *http.Request, ip string)) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		ip := clientIP(r)
		failLim := s.limiter(ip, true)
		if failLim.Tokens() < 1 {
			setCode(w, errs.RateLimited)
			w.Header().Set("Retry-After", "12")
			fail(w, errs.New(errs.RateLimited, "Too many requests with a wrong API token. Wait a little."))
			return
		}
		auth := r.Header.Get("Authorization")
		presented, ok := strings.CutPrefix(auth, "Bearer ")
		if !ok || strings.TrimSpace(presented) == "" {
			failLim.Allow()
			setCode(w, errs.Unauthorized)
			fail(w, errs.New(errs.Unauthorized, "Missing API token.").WithHint("Send the header `Authorization: Bearer <token>`; show the token with `elyon api-token show`."))
			return
		}
		if !apitoken.Equal(strings.TrimSpace(presented), s.currentToken()) {
			failLim.Allow()
			setCode(w, errs.Unauthorized)
			fail(w, errs.New(errs.Unauthorized, "Wrong API token.").WithHint("Show the current token with `elyon api-token show`."))
			return
		}
		h(w, r, ip)
	}
}

func (s *Server) command(w http.ResponseWriter, r *http.Request, ip string) {
	cmd := app.Lookup(r.URL.Path)
	if cmd == nil {
		setCode(w, errs.UnknownCommand)
		fail(w, errs.Newf(errs.UnknownCommand, "There is no command at %s. GET /v1/commands lists them.", r.URL.Path))
		return
	}
	var p app.Params
	switch r.Method {
	case http.MethodGet:
		if !cmd.ReadOnly {
			setCode(w, errs.InvalidInput)
			w.Header().Set("Allow", "POST")
			writeJSON(w, http.StatusMethodNotAllowed, s.App.MakeEnvelope(cmd.ID(), nil, errs.Newf(errs.InvalidInput, "%s changes things on-chain: use POST with a JSON body.", cmd.Path())))
			return
		}
		p = app.Params{}
		for k, v := range r.URL.Query() {
			if len(v) > 0 {
				p[k] = v[len(v)-1]
			}
		}
	case http.MethodPost:
		body, err := io.ReadAll(r.Body)
		if err != nil {
			setCode(w, errs.InvalidInput)
			fail(w, errs.New(errs.InvalidInput, "The request body is too large or unreadable."))
			return
		}
		if len(strings.TrimSpace(string(body))) > 0 && !strings.HasPrefix(r.Header.Get("Content-Type"), "application/json") {
			setCode(w, errs.InvalidInput)
			fail(w, errs.New(errs.InvalidInput, "Send the body as JSON with the header Content-Type: application/json."))
			return
		}
		if p, err = app.ParamsFromJSON(body); err != nil {
			setCode(w, errs.InvalidInput)
			fail(w, err)
			return
		}
	default:
		w.Header().Set("Allow", "GET, POST")
		writeJSON(w, http.StatusMethodNotAllowed, map[string]any{"ok": false, "error": errs.New(errs.InvalidInput, "Use GET or POST.")})
		return
	}
	ctx, cancel := context.WithTimeout(r.Context(), 15*time.Minute)
	defer cancel()
	res, err := s.App.Run(ctx, cmd, p, app.Request{Source: "http", ClientIP: ip})
	env := s.App.MakeEnvelope(cmd.ID(), res, err)
	status := http.StatusOK
	if err != nil {
		status = errs.HTTPStatus(env.Error.Code)
		setCode(w, env.Error.Code)
	}
	writeJSON(w, status, env)
}

func (s *Server) batch(w http.ResponseWriter, r *http.Request, ip string) {
	if r.Method != http.MethodPost {
		w.Header().Set("Allow", "POST")
		writeJSON(w, http.StatusMethodNotAllowed, map[string]any{"ok": false, "error": errs.New(errs.InvalidInput, "Use POST with a JSON body.")})
		return
	}
	body, err := io.ReadAll(r.Body)
	if err != nil {
		fail(w, errs.New(errs.InvalidInput, "The request body is too large or unreadable."))
		return
	}
	b, err := app.ParseBatch(body)
	if err != nil {
		setCode(w, errs.InvalidInput)
		fail(w, err)
		return
	}
	ctx, cancel := context.WithTimeout(r.Context(), 30*time.Minute)
	defer cancel()
	steps, ok := s.App.RunBatch(ctx, b, app.Request{Source: "http", ClientIP: ip})
	if !ok {
		setCode(w, "BATCH_STEP_FAILED")
	}
	// 200 even when a step failed: the per-step results say what happened (ok=false at the top).
	writeJSON(w, http.StatusOK, app.BatchEnvelope{OK: ok, Command: "batch", Steps: steps})
}

func fail(w http.ResponseWriter, err error) {
	e := errs.As(err)
	writeJSON(w, errs.HTTPStatus(e.Code), app.Envelope{OK: false, Error: e})
}

func writeJSON(w http.ResponseWriter, status int, v any) {
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.WriteHeader(status)
	enc := json.NewEncoder(w)
	enc.SetIndent("", "  ")
	_ = enc.Encode(v)
}

type statusWriter struct {
	http.ResponseWriter
	status int
	code   string
}

func (s *statusWriter) WriteHeader(code int) { s.status = code; s.ResponseWriter.WriteHeader(code) }

func setCode(w http.ResponseWriter, code string) {
	if sw, ok := w.(*statusWriter); ok {
		sw.code = code
	}
}

// Run serves until ctx is cancelled, with the idle auto-lock and the password-expiry lock running alongside.
func (s *Server) Run(ctx context.Context) error {
	srv := &http.Server{Addr: s.Opts.Listen, Handler: s.Handler(), ReadHeaderTimeout: 10 * time.Second, ReadTimeout: 30 * time.Second, WriteTimeout: 31 * time.Minute, IdleTimeout: 2 * time.Minute, MaxHeaderBytes: 16 << 10}
	if s.Opts.TLSCert != "" {
		srv.TLSConfig = &tls.Config{MinVersion: tls.VersionTLS12}
	}
	go s.watch(ctx)
	errc := make(chan error, 1)
	go func() {
		if s.Opts.TLSCert != "" {
			errc <- srv.ListenAndServeTLS(s.Opts.TLSCert, s.Opts.TLSKey)
		} else {
			errc <- srv.ListenAndServe()
		}
	}()
	select {
	case err := <-errc:
		if errors.Is(err, http.ErrServerClosed) {
			return nil
		}
		return err
	case <-ctx.Done():
		sctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		_ = srv.Shutdown(sctx)
		return nil
	}
}

// watch locks the key after AutoLock of inactivity, and when the password expires.
func (s *Server) watch(ctx context.Context) {
	t := time.NewTicker(15 * time.Second)
	defer t.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-t.C:
		}
		if !s.App.Session.Unlocked() {
			continue
		}
		if s.Opts.AutoLock > 0 && s.App.Session.IdleFor() > s.Opts.AutoLock {
			s.App.Session.Lock()
			s.Opts.Logger.Printf("auto-lock: no command for %s, the key was wiped from memory (unlock with `elyon unlock`)", s.Opts.AutoLock)
			continue
		}
		if f, err := s.App.WalletFile(); err == nil && f.Meta.PasswordStatus(time.Now()).Expired {
			s.App.Session.Lock()
			s.Opts.Logger.Printf("the wallet password expired: the key was locked. Run `elyon password change`, then `elyon unlock`.")
		}
	}
}
