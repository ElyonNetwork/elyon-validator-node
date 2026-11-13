package audit

import (
	"os"
	"runtime"
	"strings"
	"testing"
)

func TestAuditRedactsSecrets(t *testing.T) {
	home := t.TempDir()
	l := New(home)
	l.Write(Entry{Source: "http", ClientIP: "127.0.0.1", Command: "wallet.send", Params: map[string]string{"to": "0xabc", "amount": "5", "password": "hunter2-very-secret", "private_key": "0xdeadbeef", "mnemonic": "abandon abandon"}, OK: true, Txs: []string{"0x1"}})
	b, err := os.ReadFile(l.Path())
	if err != nil {
		t.Fatal(err)
	}
	s := string(b)
	for _, secret := range []string{"hunter2-very-secret", "0xdeadbeef", "abandon"} {
		if strings.Contains(s, secret) {
			t.Fatalf("secret %q in audit log: %s", secret, s)
		}
	}
	if !strings.Contains(s, `"amount":"5"`) || !strings.Contains(s, "[redacted]") || !strings.Contains(s, "wallet.send") {
		t.Fatalf("audit entry incomplete: %s", s)
	}
	if runtime.GOOS != "windows" {
		st, _ := os.Stat(l.Path())
		if st.Mode().Perm() != 0o600 {
			t.Fatalf("audit log mode %v", st.Mode().Perm())
		}
	}
}
