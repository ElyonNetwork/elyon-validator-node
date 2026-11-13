// Package config holds the settings of elyon-bot: where its data lives, which endpoints it talks to and which
// Elyon contracts it trusts. Everything has a safe built-in default; config.json only overrides.
package config

import (
	"encoding/json"
	"errors"
	"fmt"
	"net/url"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"time"

	"github.com/ethereum/go-ethereum/common"
)

// ChainID is ElyonChain mainnet. It is not configurable: elyon-bot only ever signs for this chain.
const ChainID = 55452773

// DefaultPort is the local HTTP API port of `elyon serve`.
const DefaultPort = 7457

// Contracts are the Elyon contracts elyon-bot sends transactions to or approves tokens for. The defaults are
// the production deployments of 2026-11 (deployments/55452773/*.json in the DEX repository). The DEX API is
// cross-checked against them at runtime: if the exchange reports a different contract, elyon-bot stops and
// asks you to update instead of approving an unknown contract.
type Contracts struct {
	WUSDT            string   `json:"wusdt"`
	WELN             string   `json:"weln"`
	Router           string   `json:"router"`
	Factory          string   `json:"factory"`
	PerpMarket       string   `json:"perp_market"`
	PerpTriggers     string   `json:"perp_triggers"`
	PerpLimitRouter  string   `json:"perp_limit_router"`
	LegacyPerpMarket []string `json:"legacy_perp_markets"`
	LegacyTriggers   []string `json:"legacy_perp_triggers"`
	GasSale          string   `json:"gas_sale"`
	GasSaleTreasury  string   `json:"gas_sale_treasury"`
}

// DefaultContracts are compiled in.
var DefaultContracts = Contracts{
	WUSDT:            "0x3D768c1838188DcA395489ae5D6b2C897A936f61",
	WELN:             "0xD48412aCe1346EAC5E4D0c9e613DBb7C2d25c1EE",
	Router:           "0x234F40320508Fe0338D9a33BCc759F8aE8959816",
	Factory:          "0xFe3E2B27C75250e14C22Bc581b74CB00055c48E5",
	PerpMarket:       "0x808192f498a762fc422cdf387646775414cF7bB2",
	PerpTriggers:     "0x58a99015B2ddBf98E5B4227449F4A0419C432682",
	PerpLimitRouter:  "0x3E4B0bD3077C929e5106f0D87Ca7880617844258",
	LegacyPerpMarket: []string{"0x6E1DA3b179E4E985f84B784edD44EE20dc74D50f"},
	LegacyTriggers:   []string{"0x5f64f1f97C567dC921b0d6447411f43365F83aad"},
	GasSale:          "0xfab070e9110B8e25722717142058E00ab15e7f33",
	GasSaleTreasury:  "0x59E5978558B1cb74acd8a0DF05f6fADbfA06A5fa",
}

// Config is config.json.
type Config struct {
	RPCURL      string `json:"rpc_url"`
	APIURL      string `json:"api_url"`
	ExplorerURL string `json:"explorer_url"`

	// Listen is the address of the local HTTP API (`elyon serve`).
	Listen string `json:"listen"`
	// AllowIP limits which client addresses (IP or CIDR) may call the API. Empty = loopback only when bound to
	// loopback; any address (still token-protected) otherwise.
	AllowIP []string `json:"allow_ip"`
	// AutoLock locks the key after this much time without a command ("" or "0" = never), e.g. "30m".
	AutoLock string `json:"auto_lock"`
	// RateLimit is the number of API requests per second allowed per client address (burst = 2×).
	RateLimit float64 `json:"rate_limit"`
	TLSCert   string  `json:"tls_cert"`
	TLSKey    string  `json:"tls_key"`

	// SlippageBps is the default maximum slippage of spot trades (50 = 0.5 %, like the website).
	SlippageBps int `json:"slippage_bps"`
	// ApproveUnlimited sends one unlimited wUSDT approval to the futures contracts instead of exact approvals
	// (the website's opt-in "Approve wUSDT once for all futures trades").
	ApproveUnlimited bool `json:"approve_unlimited"`
	// TxTimeoutSeconds is how long to wait for a transaction to be mined.
	TxTimeoutSeconds int `json:"tx_timeout_seconds"`

	Contracts Contracts `json:"contracts"`

	path string
}

// Default returns the built-in configuration.
func Default() *Config {
	c := DefaultContracts
	c.LegacyPerpMarket = append([]string(nil), DefaultContracts.LegacyPerpMarket...)
	c.LegacyTriggers = append([]string(nil), DefaultContracts.LegacyTriggers...)
	return &Config{
		RPCURL:           "https://mainnet.elyon.network/rpc",
		APIURL:           "https://dex.elyon.network",
		ExplorerURL:      "https://explorer.elyon.network",
		Listen:           fmt.Sprintf("127.0.0.1:%d", DefaultPort),
		AllowIP:          []string{},
		RateLimit:        20,
		SlippageBps:      50,
		TxTimeoutSeconds: 180,
		Contracts:        c,
	}
}

// DefaultHome is the per-user data directory:
//
//	Windows: %APPDATA%\Elyon            macOS: ~/Library/Application Support/Elyon
//	Linux:   $XDG_CONFIG_HOME/elyon (~/.config/elyon)
//
// ELYON_HOME overrides it (the Docker image sets ELYON_HOME=/data); so does --home.
func DefaultHome() (string, error) {
	if h := strings.TrimSpace(os.Getenv("ELYON_HOME")); h != "" {
		return filepath.Abs(h)
	}
	base, err := os.UserConfigDir()
	if err != nil {
		return "", fmt.Errorf("cannot find your user configuration directory (%v); pass --home or set ELYON_HOME", err)
	}
	switch runtime.GOOS {
	case "windows", "darwin":
		return filepath.Join(base, "Elyon"), nil
	default:
		return filepath.Join(base, "elyon"), nil
	}
}

// EnsureHome creates the home directory with owner-only permissions.
func EnsureHome(home string) error {
	if err := os.MkdirAll(home, 0o700); err != nil {
		return fmt.Errorf("creating %s: %w", home, err)
	}
	if runtime.GOOS != "windows" {
		if st, err := os.Stat(home); err == nil && st.Mode().Perm()&0o077 != 0 {
			_ = os.Chmod(home, 0o700)
		}
	}
	return nil
}

// Path is config.json in home.
func Path(home string) string { return filepath.Join(home, "config.json") }

// Load reads config.json from home (missing file = defaults) and applies ELYON_RPC_URL / ELYON_API_URL /
// ELYON_LISTEN environment overrides.
func Load(home string) (*Config, error) {
	c := Default()
	c.path = Path(home)
	b, err := os.ReadFile(c.path)
	switch {
	case err == nil:
		if err := json.Unmarshal(b, c); err != nil {
			return nil, fmt.Errorf("%s is not valid JSON: %w", c.path, err)
		}
	case errors.Is(err, os.ErrNotExist):
	default:
		return nil, err
	}
	if v := os.Getenv("ELYON_RPC_URL"); v != "" {
		c.RPCURL = v
	}
	if v := os.Getenv("ELYON_API_URL"); v != "" {
		c.APIURL = v
	}
	if v := os.Getenv("ELYON_LISTEN"); v != "" {
		c.Listen = v
	}
	if v := os.Getenv("ELYON_ALLOW_IP"); v != "" {
		c.AllowIP = splitList(v)
	}
	if v := os.Getenv("ELYON_AUTO_LOCK"); v != "" {
		c.AutoLock = v
	}
	return c, c.Validate()
}

// Save writes the configuration (0600).
func (c *Config) Save() error {
	b, err := json.MarshalIndent(c, "", "  ")
	if err != nil {
		return err
	}
	return os.WriteFile(c.path, append(b, '\n'), 0o600)
}

// FilePath is where this configuration is stored.
func (c *Config) FilePath() string { return c.path }

// Validate checks every value.
func (c *Config) Validate() error {
	for name, u := range map[string]string{"rpc_url": c.RPCURL, "api_url": c.APIURL, "explorer_url": c.ExplorerURL} {
		p, err := url.Parse(u)
		if err != nil || (p.Scheme != "https" && p.Scheme != "http") || p.Host == "" {
			return fmt.Errorf("config %s %q must be an http(s) URL", name, u)
		}
		if p.Scheme == "http" && !isLocalHost(p.Hostname()) {
			return fmt.Errorf("config %s %q must use https (plain http is only allowed for localhost)", name, u)
		}
	}
	c.APIURL = strings.TrimRight(c.APIURL, "/")
	c.ExplorerURL = strings.TrimRight(c.ExplorerURL, "/")
	if c.SlippageBps < 1 || c.SlippageBps > 500 {
		return fmt.Errorf("config slippage_bps must be between 1 and 500 (0.01%% to 5%%)")
	}
	if c.RateLimit <= 0 {
		c.RateLimit = 20
	}
	if c.TxTimeoutSeconds < 30 {
		c.TxTimeoutSeconds = 180
	}
	if _, err := c.AutoLockDuration(); err != nil {
		return err
	}
	k := c.Contracts
	for name, a := range map[string]string{"wusdt": k.WUSDT, "weln": k.WELN, "router": k.Router, "factory": k.Factory, "perp_market": k.PerpMarket, "perp_triggers": k.PerpTriggers, "perp_limit_router": k.PerpLimitRouter, "gas_sale": k.GasSale, "gas_sale_treasury": k.GasSaleTreasury} {
		if !common.IsHexAddress(a) {
			return fmt.Errorf("config contracts.%s %q is not an address", name, a)
		}
	}
	for _, a := range append(append([]string{}, k.LegacyPerpMarket...), k.LegacyTriggers...) {
		if !common.IsHexAddress(a) {
			return fmt.Errorf("config legacy contract %q is not an address", a)
		}
	}
	return nil
}

// AutoLockDuration parses AutoLock (0 = disabled).
func (c *Config) AutoLockDuration() (time.Duration, error) {
	s := strings.TrimSpace(c.AutoLock)
	if s == "" || s == "0" || s == "off" || s == "never" {
		return 0, nil
	}
	d, err := time.ParseDuration(s)
	if err != nil || d < time.Minute {
		return 0, fmt.Errorf("auto_lock %q must be a duration of at least 1m, like 30m or 2h", s)
	}
	return d, nil
}

// TxTimeout is the receipt wait limit.
func (c *Config) TxTimeout() time.Duration { return time.Duration(c.TxTimeoutSeconds) * time.Second }

// Addr parses a configured contract address.
func Addr(s string) common.Address { return common.HexToAddress(s) }

func isLocalHost(h string) bool {
	return h == "localhost" || h == "127.0.0.1" || h == "::1" || strings.HasSuffix(h, ".localhost")
}

func splitList(s string) []string {
	var out []string
	for _, p := range strings.FieldsFunc(s, func(r rune) bool { return r == ',' || r == ' ' || r == ';' }) {
		if p = strings.TrimSpace(p); p != "" {
			out = append(out, p)
		}
	}
	return out
}

// SplitList is exported for flags.
func SplitList(s string) []string { return splitList(s) }
