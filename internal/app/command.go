package app

import (
	"context"
	"encoding/json"
	"fmt"
	"math/big"
	"sort"
	"strconv"
	"strings"

	"github.com/ethereum/go-ethereum/common"

	"github.com/elyon-chain/elyon-bot/internal/amount"
	"github.com/elyon-chain/elyon-bot/internal/chain"
	"github.com/elyon-chain/elyon-bot/internal/errs"
)

// Access says what a command needs from the wallet.
type Access int

const (
	// Public commands need no wallet (market data).
	Public Access = iota
	// AddressOnly commands need the wallet address (read from wallet.json, no password).
	AddressOnly
	// KeyNeeded commands sign transactions: the key must be unlocked.
	KeyNeeded
)

// Param describes one named parameter. The same name is used as CLI flag (--take-profit for take_profit) and as
// JSON field over HTTP.
type Param struct {
	Name   string
	Help   string
	Secret bool // never written to the audit log
	Bool   bool // CLI flag without value
}

// Flag is the CLI spelling of the parameter.
func (p Param) Flag() string { return "--" + strings.ReplaceAll(p.Name, "_", "-") }

// Command is one elyon command, available identically from the CLI and the HTTP API.
type Command struct {
	Name     string // "futures open"
	Summary  string
	Usage    string // after "elyon "
	Examples []string
	Params   []Param
	// Positional turns CLI words into named parameters ("open long BTC" → side=long market=BTC).
	Positional func(args []string, p Params) error
	Access     Access
	ReadOnly   bool // safe to call with GET; no transaction
	CLIOnly    bool // interactive: not offered over HTTP
	Run        func(ctx context.Context, x *Ctx) (*Result, error)
}

// ID is the dotted name ("futures.open").
func (c *Command) ID() string { return strings.ReplaceAll(c.Name, " ", ".") }

// Path is the HTTP path ("/v1/futures/open").
func (c *Command) Path() string { return "/v1/" + strings.ReplaceAll(c.Name, " ", "/") }

// Params holds parameter values as exact strings (amounts are never floats).
type Params map[string]string

// Has reports whether a parameter was given.
func (p Params) Has(k string) bool { _, ok := p[k]; return ok }

// Str returns a trimmed value ("" if absent).
func (p Params) Str(k string) string { return strings.TrimSpace(p[k]) }

// Bool returns a boolean parameter (absent = false).
func (p Params) Bool(k string) (bool, error) {
	v, ok := p[k]
	if !ok || v == "" {
		return ok && v == "", nil
	}
	b, err := strconv.ParseBool(strings.ToLower(strings.TrimSpace(v)))
	if err != nil {
		return false, errs.Newf(errs.InvalidInput, "%s must be true or false.", k)
	}
	return b, nil
}

// Int returns an integer parameter.
func (p Params) Int(k string, def int64) (int64, error) {
	v := p.Str(k)
	if v == "" {
		return def, nil
	}
	v = strings.TrimSuffix(strings.TrimPrefix(strings.ToLower(v), "x"), "x")
	n, err := strconv.ParseInt(v, 10, 64)
	if err != nil {
		return 0, errs.Newf(errs.InvalidInput, "%s must be a whole number, got %q.", k, p.Str(k))
	}
	return n, nil
}

// Need returns a required parameter or an error naming its flag.
func (p Params) Need(k, what string) (string, error) {
	v := p.Str(k)
	if v == "" {
		return "", errs.Newf(errs.InvalidInput, "Missing %s (%s).", what, "--"+strings.ReplaceAll(k, "_", "-"))
	}
	return v, nil
}

// Amount parses a decimal parameter for a token with `decimals` decimals.
func (p Params) Amount(k string, decimals int) (*big.Int, error) {
	v, err := amount.ParsePositive(p.Str(k), decimals)
	if err != nil {
		return nil, errs.Newf(errs.InvalidInput, "%s: %v", strings.ReplaceAll(k, "_", " "), err)
	}
	return v, nil
}

// Address parses an address parameter, refusing a mistyped checksum.
func (p Params) Address(k string) (common.Address, error) {
	return ParseAddress(p.Str(k))
}

// ParseAddress accepts lower-case or correctly checksummed addresses.
func ParseAddress(s string) (common.Address, error) {
	s = strings.TrimSpace(s)
	if !common.IsHexAddress(s) {
		return common.Address{}, errs.Newf(errs.InvalidInput, "%q is not an ElyonChain address (0x followed by 40 hexadecimal characters).", s)
	}
	a := common.HexToAddress(s)
	body := strings.TrimPrefix(strings.TrimPrefix(s, "0x"), "0X")
	if body != strings.ToLower(body) && body != strings.ToUpper(body) && a.Hex()[2:] != body {
		return common.Address{}, errs.Newf(errs.InvalidInput, "%s has an invalid checksum (upper/lower case letters): it was probably mistyped.", s)
	}
	if a == (common.Address{}) {
		return common.Address{}, errs.New(errs.InvalidInput, "The zero address cannot be used.")
	}
	return a, nil
}

// ParamsFromJSON converts a JSON object into Params; numbers stay exact, nested values are refused.
func ParamsFromJSON(raw json.RawMessage) (Params, error) {
	p := Params{}
	if len(raw) == 0 || string(raw) == "null" {
		return p, nil
	}
	dec := json.NewDecoder(strings.NewReader(string(raw)))
	dec.UseNumber()
	var m map[string]any
	if err := dec.Decode(&m); err != nil {
		return nil, errs.New(errs.InvalidInput, "The request body must be a JSON object, for example {\"market\": \"BTC\"}.")
	}
	for k, v := range m {
		switch t := v.(type) {
		case nil:
		case string:
			p[k] = t
		case json.Number:
			p[k] = t.String()
		case bool:
			p[k] = strconv.FormatBool(t)
		default:
			return nil, errs.Newf(errs.InvalidInput, "Field %q must be a string, number or boolean.", k)
		}
	}
	return p, nil
}

// CheckKnown refuses parameters the command does not have (catches typos such as "levrage").
func (c *Command) CheckKnown(p Params) error {
	known := map[string]bool{}
	for _, d := range c.Params {
		known[d.Name] = true
	}
	var unknown []string
	for k := range p {
		if !known[k] {
			unknown = append(unknown, k)
		}
	}
	if len(unknown) == 0 {
		return nil
	}
	sort.Strings(unknown)
	var names []string
	for _, d := range c.Params {
		names = append(names, d.Name)
	}
	valid := "none"
	if len(names) > 0 {
		valid = strings.Join(names, ", ")
	}
	return errs.Newf(errs.InvalidInput, "Unknown field(s) for %s: %s. Valid fields: %s.", c.ID(), strings.Join(unknown, ", "), valid)
}

// Result is the outcome of a command.
type Result struct {
	Data     any
	Text     string
	Warnings []string
	Txs      []*chain.TxResult
}

// TxView is how a transaction appears in results.
type TxView struct {
	Label    string `json:"label"`
	Hash     string `json:"hash"`
	Block    uint64 `json:"block,omitempty"`
	GasUsed  uint64 `json:"gas_used,omitempty"`
	FeeELN   string `json:"fee_eln,omitempty"`
	Explorer string `json:"explorer"`
}

// registry of all commands, filled by init() functions of the command files.
var commands []*Command

func register(cmds ...*Command) { commands = append(commands, cmds...) }

// Commands returns every command sorted by name.
func Commands() []*Command {
	out := append([]*Command(nil), commands...)
	sort.Slice(out, func(i, j int) bool { return out[i].Name < out[j].Name })
	return out
}

// Lookup finds a command by "futures open", "futures.open" or "/v1/futures/open".
func Lookup(name string) *Command {
	n := strings.TrimSpace(strings.ToLower(name))
	n = strings.TrimPrefix(n, "/v1/")
	n = strings.NewReplacer(".", " ", "/", " ", "_", "-").Replace(n)
	n = strings.Join(strings.Fields(n), " ")
	for _, c := range commands {
		if c.Name == n {
			return c
		}
	}
	return nil
}

// ---------------------------------------------------------------- positional helpers

func posErr(c string, usage string) error {
	return errs.Newf(errs.InvalidInput, "Unexpected words for `%s`. Usage: elyon %s", c, usage)
}

// fill assigns positional words to parameter names in order; "to"/"of"/"for" filler words are skipped.
func fill(names ...string) func(args []string, p Params) error {
	return func(args []string, p Params) error {
		var words []string
		for _, a := range args {
			switch strings.ToLower(a) {
			case "to", "of", "for", "at", "into":
				continue
			}
			words = append(words, a)
		}
		if len(words) > len(names) {
			return fmt.Errorf("too many words: %s", strings.Join(words[len(names):], " "))
		}
		for i, w := range words {
			if !p.Has(names[i]) {
				p[names[i]] = w
			}
		}
		return nil
	}
}
