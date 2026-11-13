package app

import "github.com/elyon-chain/elyon-bot/internal/errs"

// Envelope is the JSON answer of every command, identical for `--json` on the CLI and for the HTTP API.
type Envelope struct {
	OK           bool     `json:"ok"`
	Command      string   `json:"command"`
	Result       any      `json:"result,omitempty"`
	Text         string   `json:"text,omitempty"`
	Error        *errs.E  `json:"error,omitempty"`
	Warnings     []string `json:"warnings,omitempty"`
	Transactions []TxView `json:"transactions,omitempty"`
}

// BatchEnvelope is the answer of a batch.
type BatchEnvelope struct {
	OK      bool         `json:"ok"`
	Command string       `json:"command"`
	Steps   []StepResult `json:"steps"`
}

// MakeEnvelope builds the answer of one command.
func (a *App) MakeEnvelope(id string, res *Result, err error) Envelope {
	env := Envelope{OK: err == nil, Command: id}
	if res != nil {
		env.Warnings = res.Warnings
		env.Transactions = a.TxViews(res.Txs)
		if err == nil {
			env.Result, env.Text = res.Data, res.Text
		}
	}
	if err != nil {
		env.Error = errs.As(err)
	}
	return env
}
