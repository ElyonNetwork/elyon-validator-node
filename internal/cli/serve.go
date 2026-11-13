package cli

import (
	"context"
	"fmt"
	"log"
	"os"
	"os/signal"
	"strconv"
	"syscall"
	"time"

	"github.com/elyon-chain/elyon-bot/internal/apitoken"
	"github.com/elyon-chain/elyon-bot/internal/app"
	"github.com/elyon-chain/elyon-bot/internal/config"
	"github.com/elyon-chain/elyon-bot/internal/errs"
	"github.com/elyon-chain/elyon-bot/internal/server"
	"github.com/elyon-chain/elyon-bot/internal/version"
)

var serveParams = []app.Param{
	{Name: "listen", Help: "address to listen on (default 127.0.0.1:7457)"},
	{Name: "allow_ip", Help: "comma-separated client IPs or CIDR ranges allowed to call the API (needed when listening on another interface, e.g. Docker)"},
	{Name: "auto_lock", Help: "lock the key after this long without a command, e.g. 30m (default: never)"},
	{Name: "rate", Help: "requests per second per client address (default 20)"},
	{Name: "tls_cert", Help: "serve HTTPS with this certificate file"},
	{Name: "tls_key", Help: "private key file of the certificate"},
}

func serve(a *app.App, p app.Params) error {
	cfg := a.Cfg
	if v := p.Str("listen"); v != "" {
		cfg.Listen = v
	}
	if v := p.Str("allow_ip"); v != "" {
		cfg.AllowIP = config.SplitList(v)
	}
	if v := p.Str("auto_lock"); v != "" {
		cfg.AutoLock = v
	}
	if v := p.Str("rate"); v != "" {
		r, err := strconv.ParseFloat(v, 64)
		if err != nil || r <= 0 || r > 1000 {
			return errs.New(errs.InvalidInput, "--rate must be a number of requests per second between 0.1 and 1000.")
		}
		cfg.RateLimit = r
	}
	if v := p.Str("tls_cert"); v != "" {
		cfg.TLSCert = v
	}
	if v := p.Str("tls_key"); v != "" {
		cfg.TLSKey = v
	}
	if (cfg.TLSCert == "") != (cfg.TLSKey == "") {
		return errs.New(errs.InvalidInput, "Give both --tls-cert and --tls-key, or neither.")
	}
	autoLock, err := cfg.AutoLockDuration()
	if err != nil {
		return errs.New(errs.InvalidInput, err.Error())
	}
	a.Mode = app.ModeDaemon
	f, err := a.WalletFile()
	if err != nil {
		return err
	}
	if _, _, err := apitoken.Ensure(a.Home); err != nil {
		return err
	}
	srv, err := server.New(a, server.Options{Listen: cfg.Listen, AllowIP: cfg.AllowIP, RateLimit: cfg.RateLimit, AutoLock: autoLock, TLSCert: cfg.TLSCert, TLSKey: cfg.TLSKey, Logger: log.New(os.Stderr, "elyon ", log.LstdFlags)})
	if err != nil {
		return errs.New(errs.InvalidInput, err.Error())
	}
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()
	// Check the network before asking for the password.
	if _, err := a.Chain(ctx); err != nil {
		return err
	}
	fmt.Fprintf(os.Stderr, "%s\nWallet %s\n", version.String(), f.Address)
	pw, err := askPassword(ctx, "Wallet password (unlocks trading for this session)")
	if err != nil {
		return err
	}
	u, err := a.Unlock(pw)
	for i := range pw {
		pw[i] = 0
	}
	if err != nil {
		return err
	}
	st := u.File.Meta.PasswordStatus(time.Now())
	if w := st.WarningText(); w != "" {
		fmt.Fprintln(os.Stderr, "WARNING: "+w)
	}
	if !u.File.Meta.Backup.Confirmed {
		fmt.Fprintln(os.Stderr, "WARNING: the recovery phrase is not backed up. Run `elyon wallet backup` in a terminal.")
	}
	scheme := "http"
	if cfg.TLSCert != "" {
		scheme = "https"
	}
	fmt.Fprintf(os.Stderr, "Unlocked. Local API on %s://%s (token: `elyon api-token show`, file %s)\n", scheme, cfg.Listen, apitoken.Path(a.Home))
	if !srv.Loopback() {
		if len(cfg.AllowIP) == 0 {
			fmt.Fprintln(os.Stderr, "WARNING: listening on a non-local interface WITHOUT --allow-ip: any machine that can reach this port and knows the token can trade. Restrict it with --allow-ip and a firewall.")
		} else {
			fmt.Fprintf(os.Stderr, "Accepting clients from: %v\n", cfg.AllowIP)
		}
		if cfg.TLSCert == "" {
			fmt.Fprintln(os.Stderr, "NOTE: plain HTTP on a network interface: only use it on a private network (e.g. the Docker bridge).")
		}
	}
	if autoLock > 0 {
		fmt.Fprintf(os.Stderr, "Auto-lock after %s without commands.\n", autoLock)
	}
	if cfg.TLSCert == "" {
		writeDaemonInfo(a.Home, cfg.Listen)
		defer os.Remove(daemonFile(a.Home))
	}
	fmt.Fprintln(os.Stderr, "Press Ctrl+C to stop (the key is wiped from memory).")
	err = srv.Run(ctx)
	a.Session.Lock()
	fmt.Fprintln(os.Stderr, "Stopped; the key was wiped from memory.")
	if err != nil {
		return errs.Newf(errs.Internal, "The API server stopped: %v", err)
	}
	return nil
}
