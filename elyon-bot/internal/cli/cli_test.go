package cli

import (
	"reflect"
	"strings"
	"testing"

	"github.com/elyon-chain/elyon-bot/internal/app"
)

func parse(t *testing.T, line string) (string, app.Params, error) {
	t.Helper()
	cmd, words := findCommand(strings.Fields(line))
	if cmd == nil {
		t.Fatalf("%q: no command", line)
	}
	p, pos, err := parseFlags(cmd, words)
	if err != nil {
		return cmd.Name, nil, err
	}
	if cmd.Positional != nil {
		if err := cmd.Positional(pos, p); err != nil {
			return cmd.Name, nil, err
		}
	}
	return cmd.Name, p, nil
}

func TestFluentGrammar(t *testing.T) {
	cases := []struct {
		line string
		cmd  string
		want app.Params
	}{
		{"futures open long BTC --margin 10 --leverage 5 --take-profit 80000", "futures open", app.Params{"side": "long", "market": "BTC", "margin": "10", "leverage": "5", "take_profit": "80000"}},
		{"futures open short eth --size=100 --leverage=10 --stop-loss 2100", "futures open", app.Params{"side": "short", "market": "eth", "size": "100", "leverage": "10", "stop_loss": "2100"}},
		{"futures close 6253401 --percent 50", "futures close", app.Params{"id": "6253401", "percent": "50"}},
		{"futures close-all --market BTC", "futures close-all", app.Params{"market": "BTC"}},
		{"futures set-tp-sl 42 --take-profit none --stop-loss 65000", "futures set-tp-sl", app.Params{"id": "42", "take_profit": "none", "stop_loss": "65000"}},
		{"futures limit long BTC --price 65000 --margin 10 --leverage 5 --expires 7d", "futures limit", app.Params{"side": "long", "market": "BTC", "price": "65000", "margin": "10", "leverage": "5", "expires": "7d"}},
		{"futures cancel 12", "futures cancel", app.Params{"id": "12"}},
		{"spot buy BTC --spend 100", "spot buy", app.Params{"market": "BTC", "spend": "100"}},
		{"spot buy 0.01 BTC", "spot buy", app.Params{"amount": "0.01", "market": "BTC"}},
		{"spot sell all BTC --slippage 1", "spot sell", app.Params{"amount": "all", "market": "BTC", "slippage": "1"}},
		{"spot swap 5 wUSDT to wBTC", "spot swap", app.Params{"amount": "5", "from": "wUSDT", "to": "wBTC"}},
		{"spot quote swap 0.1 wBTC to wETH", "spot quote", app.Params{"side": "swap", "amount": "0.1", "from": "wBTC", "to": "wETH"}},
		{"spot quote buy BTC --spend 1", "spot quote", app.Params{"side": "buy", "market": "BTC", "spend": "1"}},
		{"wallet send 25 wUSDT to 0x0E0bB1BDEc7248eBac6eFBE624ceAEd86bda3e27", "wallet send", app.Params{"amount": "25", "token": "wUSDT", "to": "0x0E0bB1BDEc7248eBac6eFBE624ceAEd86bda3e27"}},
		{"wallet send all ELN 0x0E0bB1BDEc7248eBac6eFBE624ceAEd86bda3e27", "wallet send", app.Params{"amount": "all", "token": "ELN", "to": "0x0E0bB1BDEc7248eBac6eFBE624ceAEd86bda3e27"}},
		{"wallet balance --all", "wallet balance", app.Params{"all": "true"}},
		{"wallet limit 500 wUSDT", "wallet limit", app.Params{"amount": "500", "token": "wUSDT"}},
		{"wrap 0.5 ELN", "wrap", app.Params{"amount": "0.5"}},
		{"unwrap all WELN", "unwrap", app.Params{"amount": "all"}},
		{"gas buy 1", "gas buy", app.Params{"amount": "1"}},
		{"portfolio", "portfolio", app.Params{}},
	}
	for _, c := range cases {
		name, p, err := parse(t, c.line)
		if err != nil || name != c.cmd || !reflect.DeepEqual(p, c.want) {
			t.Errorf("%q -> %s %v %v, want %s %v", c.line, name, p, err, c.cmd, c.want)
		}
	}
}

func TestGrammarErrors(t *testing.T) {
	for _, line := range []string{
		"futures open long BTC --levrage 5",            // typo
		"futures open long BTC --margin",               // missing value
		"wallet send 1 ELN to 0xabc --password secret", // password on the command line is refused
		"futures close 1 2 3",                          // too many words
	} {
		if _, _, err := parse(t, line); err == nil {
			t.Errorf("%q accepted", line)
		}
	}
	if c, _ := findCommand([]string{"futures", "teleport"}); c != nil {
		t.Error("unknown subcommand matched")
	}
	if err := unknownCommand([]string{"futures", "teleport"}); err == nil || !strings.Contains(err.Error(), "futures open") {
		t.Errorf("unknown command help: %v", err)
	}
	g, rest, _ := parseGlobals([]string{"--json", "status", "--home", "/tmp/x", "--no-daemon"})
	if !g.json || !g.noDaemon || g.home != "/tmp/x" || len(rest) != 1 {
		t.Errorf("globals %+v %v", g, rest)
	}
}

func TestEveryCommandHasHelp(t *testing.T) {
	for _, c := range allCommands() {
		if c.Summary == "" || c.Usage == "" {
			t.Errorf("%s lacks summary/usage", c.Name)
		}
		if !c.CLIOnly && c.Run == nil {
			t.Errorf("%s has no implementation", c.Name)
		}
	}
}
