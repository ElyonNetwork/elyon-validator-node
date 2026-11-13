// Package cli is the command-line front end of elyon: `elyon <command> …`. It parses fluent English commands
// into the same named parameters the HTTP API takes, runs them (locally, or through a running `elyon serve`
// daemon of the same home), and prints friendly text or, with --json, the same JSON the HTTP API returns.
package cli

import (
	"context"
	"encoding/json"
	"fmt"
	"os"
	"os/signal"
	"sort"
	"strings"
	"syscall"

	"github.com/elyon-chain/elyon-bot/internal/app"
	"github.com/elyon-chain/elyon-bot/internal/config"
	"github.com/elyon-chain/elyon-bot/internal/errs"
	"github.com/elyon-chain/elyon-bot/internal/version"
)

type globals struct {
	json     bool
	home     string
	noDaemon bool
	quiet    bool
	help     bool
}

// extra commands that exist only on the command line.
var cliOnly = map[string]*app.Command{
	"serve":            {Name: "serve", Summary: "Start the local HTTP API for bots: unlock once, then trade over http://127.0.0.1:7457.", Usage: "serve [--listen 127.0.0.1:7457] [--allow-ip 172.17.0.0/16] [--auto-lock 30m] [--rate 20] [--tls-cert f --tls-key f]", Params: serveParams, CLIOnly: true},
	"run":              {Name: "run", Summary: "Run a batch file: several commands in order, one result per step.", Usage: "run <batch.json|-> [--continue-on-error]", Params: []app.Param{{Name: "file"}, {Name: "continue_on_error", Bool: true}}, CLIOnly: true},
	"api-token show":   {Name: "api-token show", Summary: "Show the secret token bots send to the local API (creates it if missing).", Usage: "api-token show", CLIOnly: true},
	"api-token rotate": {Name: "api-token rotate", Summary: "Replace the API token (the old one stops working at once).", Usage: "api-token rotate", CLIOnly: true},
	"config show":      {Name: "config show", Summary: "Show the configuration in use and where config.json is.", Usage: "config show", CLIOnly: true},
	"help":             {Name: "help", Summary: "Show help for all commands or one command.", Usage: "help [command]", CLIOnly: true},
}

// Main runs the CLI and returns the process exit code.
func Main(args []string) int {
	g, rest, err := parseGlobals(args)
	if err != nil {
		return fail(g, "", err)
	}
	if len(rest) == 0 {
		printOverview()
		return 0
	}
	if rest[0] == "--version" || rest[0] == "-v" {
		rest = []string{"version"}
	}
	home := g.home
	if home == "" {
		if home, err = config.DefaultHome(); err != nil {
			return fail(g, "", errs.New(errs.InvalidInput, err.Error()))
		}
	}
	if err := config.EnsureHome(home); err != nil {
		return fail(g, "", errs.New(errs.InvalidInput, err.Error()))
	}
	cfg, err := config.Load(home)
	if err != nil {
		return fail(g, "", errs.New(errs.InvalidInput, err.Error()))
	}
	a := app.New(home, cfg, app.ModeCLI)
	a.AskPassword = askPassword
	if !g.json && !g.quiet {
		a.Progress = func(s string) { fmt.Fprintln(os.Stderr, "… "+s) }
	}

	cmd, words := findCommand(rest)
	if cmd == nil {
		return fail(g, "", unknownCommand(rest))
	}
	if g.help || (cmd.Name == "help") {
		if cmd.Name == "help" {
			printHelp(strings.Join(words, " "))
		} else {
			printCommandHelp(cmd)
		}
		return 0
	}
	p, positional, err := parseFlags(cmd, words)
	if err != nil {
		return fail(g, cmd.ID(), err)
	}
	if cmd.Positional != nil {
		if err := cmd.Positional(positional, p); err != nil {
			return fail(g, cmd.ID(), errs.Newf(errs.InvalidInput, "%v. Usage: elyon %s", err, cmd.Usage))
		}
	} else if len(positional) > 0 && cmd.Name != "run" {
		return fail(g, cmd.ID(), errs.Newf(errs.InvalidInput, "Unexpected words %q. Usage: elyon %s", strings.Join(positional, " "), cmd.Usage))
	}

	// Interactive and CLI-only commands.
	switch cmd.Name {
	case "setup":
		return done(g, cmd, setup(a))
	case "wallet create":
		return done(g, cmd, walletCreate(a))
	case "wallet restore":
		return done(g, cmd, walletRestore(a, p))
	case "wallet backup":
		return done(g, cmd, walletBackup(a, p))
	case "password change":
		return done(g, cmd, passwordChange(a))
	case "password policy":
		return done(g, cmd, passwordPolicy(a, p))
	case "api-token show":
		return done(g, cmd, apiTokenShow(a, false))
	case "api-token rotate":
		return done(g, cmd, apiTokenShow(a, true))
	case "config show":
		return done(g, cmd, configShow(a))
	case "serve":
		return done(g, cmd, serve(a, p))
	case "run":
		if len(positional) == 1 {
			p["file"] = positional[0]
		}
		return runBatch(g, a, p)
	}

	// Commands that sign go through a running daemon of this home when there is one (no second password prompt,
	// one process holding the key).
	if !g.noDaemon && (cmd.Access == app.KeyNeeded || cmd.Name == "unlock" || cmd.Name == "lock") {
		if r := findDaemon(a); r != nil {
			return runRemote(g, a, r, cmd, p)
		}
	}
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()
	res, err := a.Run(ctx, cmd, p, app.Request{Source: "cli"})
	a.Session.Lock()
	return output(g, a.MakeEnvelope(cmd.ID(), res, err))
}

func parseGlobals(args []string) (globals, []string, error) {
	var g globals
	var rest []string
	for i := 0; i < len(args); i++ {
		a := args[i]
		switch {
		case a == "--json":
			g.json = true
		case a == "--no-daemon":
			g.noDaemon = true
		case a == "--quiet" || a == "-q":
			g.quiet = true
		case a == "--help" || a == "-h":
			g.help = true
		case a == "--home":
			if i+1 >= len(args) {
				return g, nil, errs.New(errs.InvalidInput, "--home needs a folder.")
			}
			g.home = args[i+1]
			i++
		case strings.HasPrefix(a, "--home="):
			g.home = strings.TrimPrefix(a, "--home=")
		default:
			rest = append(rest, a)
		}
	}
	return g, rest, nil
}

// findCommand matches the longest command name at the start of args.
func findCommand(args []string) (*app.Command, []string) {
	for n := min(3, len(args)); n >= 1; n-- {
		name := strings.ToLower(strings.Join(args[:n], " "))
		if c, ok := cliOnly[name]; ok {
			return c, args[n:]
		}
		if strings.HasPrefix(args[n-1], "-") {
			continue
		}
		if c := app.Lookup(name); c != nil && c.Name == strings.Join(strings.Fields(name), " ") {
			return c, args[n:]
		}
	}
	return nil, nil
}

func unknownCommand(args []string) error {
	group := strings.ToLower(args[0])
	var names []string
	for _, c := range allCommands() {
		if strings.HasPrefix(c.Name, group+" ") {
			names = append(names, "elyon "+c.Name)
		}
	}
	if len(names) > 0 {
		return errs.Newf(errs.UnknownCommand, "Unknown command \"%s\". Commands of %s: %s.", strings.Join(args, " "), group, strings.Join(names, ", "))
	}
	return errs.Newf(errs.UnknownCommand, "Unknown command \"%s\".", strings.Join(args, " ")).WithHint("Run `elyon help` for the list of commands.")
}

// parseFlags reads --name value / --name=value / boolean --name, returning the remaining positional words.
func parseFlags(cmd *app.Command, words []string) (app.Params, []string, error) {
	p := app.Params{}
	var positional []string
	byFlag := map[string]app.Param{}
	for _, d := range cmd.Params {
		byFlag[strings.TrimPrefix(d.Flag(), "--")] = d
	}
	for i := 0; i < len(words); i++ {
		w := words[i]
		if !strings.HasPrefix(w, "--") || len(w) == 2 {
			positional = append(positional, w)
			continue
		}
		name, val, hasVal := strings.Cut(strings.TrimPrefix(w, "--"), "=")
		name = strings.ToLower(strings.ReplaceAll(name, "_", "-"))
		d, ok := byFlag[name]
		if !ok {
			var valid []string
			for f := range byFlag {
				if f != "password" {
					valid = append(valid, "--"+f)
				}
			}
			sort.Strings(valid)
			hint := "This command has no options."
			if len(valid) > 0 {
				hint = "Options of `" + cmd.Name + "`: " + strings.Join(valid, ", ") + "."
			}
			return nil, nil, errs.Newf(errs.InvalidInput, "Unknown option --%s.", name).WithHint(hint)
		}
		if d.Name == "password" {
			return nil, nil, errs.New(errs.InvalidInput, "Never type the password on the command line (it would stay in your shell history). elyon asks for it when needed.")
		}
		switch {
		case d.Bool && !hasVal:
			p[d.Name] = "true"
		case hasVal:
			p[d.Name] = val
		case i+1 < len(words):
			p[d.Name] = words[i+1]
			i++
		default:
			return nil, nil, errs.Newf(errs.InvalidInput, "--%s needs a value.", name)
		}
	}
	return p, positional, nil
}

func runRemote(g globals, a *app.App, r *remote, cmd *app.Command, p app.Params) int {
	if !g.json && !g.quiet {
		fmt.Fprintf(os.Stderr, "… sent to the running elyon daemon (%s)\n", r.url)
	}
	if cmd.Name == "unlock" {
		pw, err := readHidden("Wallet password")
		if err != nil {
			return fail(g, cmd.ID(), err)
		}
		p["password"] = string(pw)
	}
	env, err := r.call(cmd.Path(), p)
	if err != nil {
		return fail(g, cmd.ID(), err)
	}
	// A transfer to an address that is not approved needs the password: ask and retry once.
	if !env.OK && env.Error != nil && env.Error.Code == errs.TransferNotAllowed && stdinIsTerminal() {
		fmt.Fprintln(os.Stderr, env.Error.Message)
		pw, err := readHidden("Wallet password (confirms this transfer)")
		if err != nil {
			return fail(g, cmd.ID(), err)
		}
		p["password"] = string(pw)
		if env, err = r.call(cmd.Path(), p); err != nil {
			return fail(g, cmd.ID(), err)
		}
	}
	return output(g, *env)
}

func runBatch(g globals, a *app.App, p app.Params) int {
	file := p.Str("file")
	if file == "" {
		return fail(g, "batch", errs.New(errs.InvalidInput, "Name the batch file: elyon run batch.json (or - for standard input)."))
	}
	b, err := app.ReadBatchFile(file)
	if err != nil {
		return fail(g, "batch", err)
	}
	if cont, _ := p.Bool("continue_on_error"); cont {
		f := false
		b.StopOnError = &f
	}
	var env *app.BatchEnvelope
	needsKey := false
	for _, s := range b.Commands {
		if c := app.Lookup(s.Command); c != nil && c.Access == app.KeyNeeded {
			needsKey = true
		}
	}
	if r := findDaemon(a); needsKey && r != nil && !g.noDaemon {
		raw, _ := json.Marshal(b)
		if env, err = r.batch(raw); err != nil {
			return fail(g, "batch", err)
		}
	} else {
		ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
		defer stop()
		steps, ok := a.RunBatch(ctx, b, app.Request{Source: "cli"})
		a.Session.Lock()
		env = &app.BatchEnvelope{OK: ok, Command: "batch", Steps: steps}
	}
	if g.json {
		printJSON(env)
	} else {
		for _, s := range env.Steps {
			status := "OK"
			if s.Skipped {
				status = "SKIPPED"
			} else if !s.OK {
				status = "FAILED"
			}
			fmt.Printf("── step %d: %s — %s\n", s.Index+1, s.Command, status)
			if s.OK {
				fmt.Print(s.Text)
			} else if s.Error != nil && !s.Skipped {
				fmt.Println("  " + s.Error.Error())
			}
			for _, w := range s.Warnings {
				fmt.Fprintln(os.Stderr, "  Warning: "+w)
			}
		}
	}
	if !env.OK {
		return 1
	}
	return 0
}

func done(g globals, cmd *app.Command, err error) int {
	if err != nil {
		return fail(g, cmd.ID(), err)
	}
	if g.json {
		printJSON(app.Envelope{OK: true, Command: cmd.ID()})
	}
	return 0
}

func output(g globals, env app.Envelope) int {
	if g.json {
		printJSON(env)
	} else {
		if env.OK {
			fmt.Print(env.Text)
			if len(env.Transactions) > 1 {
				fmt.Println("  Transactions:")
				for _, t := range env.Transactions {
					fmt.Printf("    %-34s %s\n", t.Label, t.Hash)
				}
			}
		} else {
			printError(env.Error)
			for _, t := range env.Transactions {
				fmt.Fprintf(os.Stderr, "  (sent before the error: %s %s)\n", t.Label, t.Hash)
			}
		}
		for _, w := range env.Warnings {
			fmt.Fprintln(os.Stderr, "Warning: "+w)
		}
	}
	if env.OK {
		return 0
	}
	return 1
}

func fail(g globals, id string, err error) int {
	e := errs.As(err)
	if g.json {
		printJSON(app.Envelope{OK: false, Command: id, Error: e})
	} else {
		printError(e)
	}
	return 1
}

func printError(e *errs.E) {
	if e == nil {
		return
	}
	fmt.Fprintf(os.Stderr, "Error: %s\n", e.Message)
	if e.Hint != "" {
		fmt.Fprintf(os.Stderr, "  → %s\n", e.Hint)
	}
}

func printJSON(v any) {
	enc := json.NewEncoder(os.Stdout)
	enc.SetEscapeHTML(false)
	enc.SetIndent("", "  ")
	_ = enc.Encode(v)
}

func allCommands() []*app.Command {
	out := app.Commands()
	for _, c := range cliOnly {
		if c.Name != "help" {
			out = append(out, c)
		}
	}
	sort.Slice(out, func(i, j int) bool { return out[i].Name < out[j].Name })
	return out
}

var groups = []struct{ title, prefix string }{
	{"Getting started", "setup|status|version|portfolio"},
	{"Wallet", "wallet |password |api-token |config "},
	{"Spot (swap wrapped tokens against wUSDT)", "spot "},
	{"Futures (perpetuals, isolated margin)", "futures "},
	{"Gas and wrapping", "gas |wrap|unwrap"},
	{"Daemon and automation", "serve|unlock|lock|run|tx|commands"},
}

func printOverview() {
	fmt.Printf("%s\nCommand-line trading client for the Elyon DEX (ElyonChain %d). Your key never leaves this computer.\n\n", version.String(), config.ChainID)
	fmt.Println("Usage: elyon <command> [options]        Add --json for machine-readable output, --help for details.")
	seen := map[string]bool{}
	for _, gr := range groups {
		fmt.Printf("\n%s\n", gr.title)
		for _, c := range allCommands() {
			if seen[c.Name] || !matchGroup(c.Name, gr.prefix) {
				continue
			}
			seen[c.Name] = true
			fmt.Printf("  %-22s %s\n", c.Name, c.Summary)
		}
	}
	fmt.Println("\nGlobal options: --json  --home <folder>  --no-daemon  --quiet")
	fmt.Println("Examples: elyon setup · elyon wallet balance · elyon futures open long BTC --margin 10 --leverage 5 · elyon serve")
}

func matchGroup(name, spec string) bool {
	for _, p := range strings.Split(spec, "|") {
		if strings.HasSuffix(p, " ") && strings.HasPrefix(name, p) || name == p || (!strings.HasSuffix(p, " ") && strings.HasPrefix(name, p)) {
			return true
		}
	}
	return false
}

func printHelp(topic string) {
	topic = strings.TrimSpace(strings.ToLower(topic))
	if topic == "" {
		printOverview()
		return
	}
	if c, _ := findCommand(strings.Fields(topic)); c != nil && c.Name == topic {
		printCommandHelp(c)
		return
	}
	found := false
	for _, c := range allCommands() {
		if strings.HasPrefix(c.Name, topic) {
			if !found {
				fmt.Printf("Commands starting with %q:\n\n", topic)
			}
			found = true
			fmt.Printf("  elyon %-60s\n      %s\n", c.Usage, c.Summary)
		}
	}
	if !found {
		fmt.Printf("No command %q. Run `elyon help`.\n", topic)
	}
}

func printCommandHelp(c *app.Command) {
	fmt.Printf("elyon %s\n\n  %s\n", c.Usage, c.Summary)
	if !c.CLIOnly {
		method := "POST"
		if c.ReadOnly {
			method = "GET or POST"
		}
		fmt.Printf("\n  HTTP API: %s %s (JSON fields = the option names with underscores)\n", method, c.Path())
	}
	if len(c.Params) > 0 {
		fmt.Println("\nOptions:")
		for _, p := range c.Params {
			if p.Name == "password" {
				continue
			}
			help := p.Help
			if help == "" {
				help = defaultHelp[p.Name]
			}
			fmt.Printf("  %-34s %s\n", p.Flag(), help)
		}
	}
	if len(c.Examples) > 0 {
		fmt.Println("\nExamples:")
		for _, e := range c.Examples {
			fmt.Println("  " + e)
		}
	}
}

// defaultHelp describes parameters that are self-explanatory in most commands.
var defaultHelp = map[string]string{
	"market":   "market ticker, e.g. BTC (also BTC_USDT, wBTC, btc-usdt)",
	"side":     "long or short",
	"id":       "position or order id (a number)",
	"search":   "text to look for in tickers and names",
	"limit":    "how many rows to show (0 = all)",
	"from":     "token you give, e.g. wUSDT or wBTC",
	"to":       "token you get, or destination address",
	"amount":   "amount (a plain number such as 0.5), or all",
	"hash":     "transaction hash (0x…)",
	"all":      "include everything (no value needed)",
	"token":    "ELN, wUSDT, WELN, a ticker such as wBTC, or a token address",
	"file":     "batch file (JSON), or - for standard input",
	"spend":    "wUSDT to spend",
	"category": "crypto, metals, indices, energy, forex or stocks",
}
