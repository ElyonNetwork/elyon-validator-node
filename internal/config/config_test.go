package config

import (
	"os"
	"path/filepath"
	"testing"
)

func TestConfigDefaultsAndValidation(t *testing.T) {
	home := t.TempDir()
	c, err := Load(home)
	if err != nil {
		t.Fatal(err)
	}
	if c.RPCURL != "https://mainnet.elyon.network/rpc" || c.Listen != "127.0.0.1:7457" || c.SlippageBps != 50 || c.Contracts.PerpTriggers != DefaultContracts.PerpTriggers {
		t.Fatalf("defaults %+v", c)
	}
	bad := map[string]string{
		`{"rpc_url": "http://evil.example/rpc"}`: "plain http to a remote host",
		`{"slippage_bps": 5000}`:                 "50% slippage",
		`{"auto_lock": "5s"}`:                    "auto-lock under a minute",
		`{"contracts": {"router": "nope"}}`:      "bad contract address",
		`{not json`:                              "broken JSON",
	}
	for body, why := range bad {
		_ = os.WriteFile(filepath.Join(home, "config.json"), []byte(body), 0o600)
		if _, err := Load(home); err == nil {
			t.Errorf("accepted %s", why)
		}
	}
	_ = os.WriteFile(filepath.Join(home, "config.json"), []byte(`{"rpc_url": "http://127.0.0.1:8545", "auto_lock": "30m", "api_url": "https://dex.elyon.network/"}`), 0o600)
	c, err = Load(home)
	if err != nil {
		t.Fatal(err)
	}
	if d, _ := c.AutoLockDuration(); d.Minutes() != 30 || c.APIURL != "https://dex.elyon.network" || c.Contracts.WUSDT != DefaultContracts.WUSDT {
		t.Fatalf("overrides %+v", c)
	}
	t.Setenv("ELYON_HOME", filepath.Join(home, "x"))
	if h, _ := DefaultHome(); h != filepath.Join(home, "x") {
		t.Fatalf("ELYON_HOME ignored: %s", h)
	}
}
