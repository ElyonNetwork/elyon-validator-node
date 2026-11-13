// Package audit writes one JSON line per command to audit.log in the elyon home (mode 0600): when, from where,
// which command with which parameters, the outcome and the transaction hashes. Secrets (passwords, recovery
// phrases, private keys, API tokens) are never written: their values are replaced by "[redacted]".
package audit

import (
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"time"
)

// MaxSize is the size at which audit.log is rotated to audit.log.1.
const MaxSize = 10 << 20

var secretKeys = map[string]bool{"password": true, "new_password": true, "old_password": true, "private_key": true, "mnemonic": true, "phrase": true, "words": true, "token": true, "api_token": true, "secret": true}

// IsSecretKey reports whether a parameter name holds a secret.
func IsSecretKey(k string) bool { return secretKeys[strings.ToLower(k)] }

// Entry is one audit record.
type Entry struct {
	Time     string            `json:"time"`
	Source   string            `json:"source"` // cli, http, batch
	ClientIP string            `json:"client_ip,omitempty"`
	Command  string            `json:"command"`
	Params   map[string]string `json:"params,omitempty"`
	OK       bool              `json:"ok"`
	Error    string            `json:"error_code,omitempty"`
	Message  string            `json:"error,omitempty"`
	Txs      []string          `json:"txs,omitempty"`
	Millis   int64             `json:"duration_ms"`
}

// Logger appends entries to a file.
type Logger struct {
	mu   sync.Mutex
	path string
}

// New returns a logger writing to home/audit.log.
func New(home string) *Logger { return &Logger{path: filepath.Join(home, "audit.log")} }

// Path is the log file.
func (l *Logger) Path() string { return l.path }

// Redact copies params with secret values replaced.
func Redact(p map[string]string) map[string]string {
	if len(p) == 0 {
		return nil
	}
	out := make(map[string]string, len(p))
	for k, v := range p {
		if IsSecretKey(k) {
			out[k] = "[redacted]"
		} else {
			if len(v) > 200 {
				v = v[:200] + "…"
			}
			out[k] = v
		}
	}
	return out
}

// Write appends an entry (errors are ignored: auditing must never block trading, but the file is created 0600).
func (l *Logger) Write(e Entry) {
	if l == nil {
		return
	}
	e.Params = Redact(e.Params)
	if e.Time == "" {
		e.Time = time.Now().UTC().Format(time.RFC3339Nano)
	}
	b, err := json.Marshal(e)
	if err != nil {
		return
	}
	l.mu.Lock()
	defer l.mu.Unlock()
	if st, err := os.Stat(l.path); err == nil && st.Size() > MaxSize {
		_ = os.Rename(l.path, l.path+".1")
	}
	f, err := os.OpenFile(l.path, os.O_CREATE|os.O_APPEND|os.O_WRONLY, 0o600)
	if err != nil {
		return
	}
	defer f.Close()
	_, _ = f.Write(append(b, '\n'))
}
