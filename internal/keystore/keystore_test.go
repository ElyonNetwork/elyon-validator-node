package keystore

import (
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
	"time"

	"github.com/ethereum/go-ethereum/crypto"
)

func init() { ScryptN = 1 << 14 } // fast tests; production uses 2^18

const goodPassword = "correct horse battery staple"

var t0 = time.Date(2026, 11, 13, 12, 0, 0, 0, time.UTC)

// Vectors computed independently with ethers.js HDNodeWallet.fromPhrase(phrase, "", "m/44'/60'/0'/0/0").
func TestDerivationVectors(t *testing.T) {
	cases := map[string]string{
		"test test test test test test test test test test test junk":                                   "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266",
		"abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about": "0x9858EfFD232B4033E47d90003D41EC34EcaEda94",
		strings.Repeat("abandon ", 23) + "art":                                                          "0xF278cF59F82eDcf871d630F28EcC8056f25C1cdb",
		"legal winner thank year wave sausage worth useful legal winner thank year wave sausage worth useful legal winner thank year wave sausage worth title": "0x2f826cb22E80a2c40f149Ecb92b2Fa5ecBf67170",
	}
	for phrase, want := range cases {
		k, err := KeyFromMnemonic(phrase)
		if err != nil {
			t.Fatalf("%q: %v", phrase, err)
		}
		if got := crypto.PubkeyToAddress(k.PublicKey).Hex(); got != want {
			t.Errorf("%q: got %s want %s", phrase, got, want)
		}
	}
}

func TestMnemonicValidation(t *testing.T) {
	if _, err := NormalizeMnemonic("abandon abandon"); err == nil {
		t.Error("2 words accepted")
	}
	if _, err := NormalizeMnemonic(strings.Repeat("abandon ", 23) + "abandn"); err == nil || !strings.Contains(err.Error(), "word 24") {
		t.Errorf("typo not reported precisely: %v", err)
	}
	if _, err := NormalizeMnemonic(strings.Repeat("abandon ", 24)); err == nil || !strings.Contains(err.Error(), "checksum") {
		t.Errorf("bad checksum accepted: %v", err)
	}
	norm, err := NormalizeMnemonic("  ABANDON abandon\tabandon abandon abandon abandon abandon abandon abandon abandon abandon ABOUT ")
	if err != nil || norm != "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about" {
		t.Errorf("normalisation failed: %q %v", norm, err)
	}
	m, err := NewMnemonic()
	if err != nil || len(strings.Fields(m)) != 24 {
		t.Fatalf("new mnemonic: %q %v", m, err)
	}
	if _, err := NormalizeMnemonic(m); err != nil {
		t.Errorf("fresh mnemonic invalid: %v", err)
	}
}

func TestPasswordPolicy(t *testing.T) {
	for _, bad := range []string{"", "short", "elevenchars", "aaaaaaaaaaaaaaaa", "abababababababab", " leading space pw", "trailing space pw ", "my123456789012pw", "Password1234!!"} {
		if err := ValidatePassword([]byte(bad)); err == nil {
			t.Errorf("weak password accepted: %q", bad)
		}
	}
	for _, good := range []string{goodPassword, "Tr4ding-b0t-2026!", "zwölf Zeichen ok"} {
		if err := ValidatePassword([]byte(good)); err != nil {
			t.Errorf("good password refused: %q: %v", good, err)
		}
	}
}

func TestCreateUnlockWrongPassword(t *testing.T) {
	home := t.TempDir()
	u, err := Create(home, []byte(goodPassword), t0)
	if err != nil {
		t.Fatal(err)
	}
	if len(strings.Fields(u.Secret())) != 24 {
		t.Fatal("create must keep the phrase for the first backup")
	}
	addr := u.Address
	u.Wipe()
	if u.Key != nil || u.Secret() != "" {
		t.Fatal("wipe left key material")
	}

	if runtime.GOOS != "windows" {
		st, err := os.Stat(Path(home))
		if err != nil || st.Mode().Perm() != 0o600 {
			t.Fatalf("wallet file mode %v %v", st.Mode().Perm(), err)
		}
	}
	raw, _ := os.ReadFile(Path(home))
	words := strings.Fields(phraseOf(t, home))
	if strings.Contains(string(raw), words[0]+" "+words[1]) || strings.Contains(string(raw), "\"mnemonic\":") || strings.Contains(string(raw), "private_key") {
		t.Fatal("plaintext secret in wallet file")
	}

	f, err := Load(home)
	if err != nil {
		t.Fatal(err)
	}
	if f.AddressValue() != addr {
		t.Fatal("address mismatch")
	}
	if _, err := f.Unlock([]byte("not the password at all"), t0, UnlockOptions{}); !errors.Is(err, ErrWrongPassword) {
		t.Fatalf("wrong password: got %v", err)
	}
	u2, err := f.Unlock([]byte(goodPassword), t0, UnlockOptions{})
	if err != nil {
		t.Fatal(err)
	}
	if u2.Address != addr || u2.Secret() != "" {
		t.Fatal("unlock without KeepSecret must not keep the phrase")
	}
	if err := f.VerifyPassword([]byte(goodPassword)); err != nil {
		t.Fatal(err)
	}
	if _, err := Create(home, []byte(goodPassword), t0); !errors.Is(err, ErrWalletExists) {
		t.Fatalf("overwrite allowed: %v", err)
	}
}

func phraseOf(t *testing.T, home string) string {
	t.Helper()
	f, err := Load(home)
	if err != nil {
		t.Fatal(err)
	}
	u, err := f.Unlock([]byte(goodPassword), t0, UnlockOptions{KeepSecret: true})
	if err != nil {
		t.Fatal(err)
	}
	defer u.Wipe()
	return u.Secret()
}

func TestTamperDetection(t *testing.T) {
	home := t.TempDir()
	u, err := Create(home, []byte(goodPassword), t0)
	if err != nil {
		t.Fatal(err)
	}
	u.Wipe()
	edit := func(mut func(m map[string]any)) {
		t.Helper()
		b, _ := os.ReadFile(Path(home))
		var m map[string]any
		_ = json.Unmarshal(b, &m)
		mut(m)
		b, _ = json.Marshal(m)
		_ = os.WriteFile(Path(home), b, 0o600)
	}
	orig, _ := os.ReadFile(Path(home))

	// An attacker adds their address to the allowlist: refused at unlock.
	edit(func(m map[string]any) {
		meta := m["meta"].(map[string]any)
		meta["allowlist"] = []any{map[string]any{"address": "0x000000000000000000000000000000000000dEaD", "added_at": t0.Format(time.RFC3339)}}
	})
	f, _ := Load(home)
	if _, err := f.Unlock([]byte(goodPassword), t0, UnlockOptions{}); !errors.Is(err, ErrTampered) {
		t.Fatalf("allowlist tampering not detected: %v", err)
	}
	// An attacker resets the password age to dodge expiry: refused.
	_ = os.WriteFile(Path(home), orig, 0o600)
	edit(func(m map[string]any) { m["meta"].(map[string]any)["password_max_age_days"] = 365 })
	f, _ = Load(home)
	if _, err := f.Unlock([]byte(goodPassword), t0, UnlockOptions{}); !errors.Is(err, ErrTampered) {
		t.Fatalf("policy tampering not detected: %v", err)
	}
	// An attacker swaps the displayed address: the ciphertext is bound to it.
	_ = os.WriteFile(Path(home), orig, 0o600)
	edit(func(m map[string]any) { m["address"] = "0x000000000000000000000000000000000000dEaD" })
	f, _ = Load(home)
	if _, err := f.Unlock([]byte(goodPassword), t0, UnlockOptions{}); err == nil {
		t.Fatal("address swap not detected")
	}
	// Weakened KDF parameters are refused before any work is done.
	_ = os.WriteFile(Path(home), orig, 0o600)
	edit(func(m map[string]any) { m["crypto"].(map[string]any)["kdfparams"].(map[string]any)["n"] = 2 })
	f, _ = Load(home)
	if _, err := f.Unlock([]byte(goodPassword), t0, UnlockOptions{}); err == nil {
		t.Fatal("weak kdf accepted")
	}
}

func TestPasswordAgeAndChange(t *testing.T) {
	home := t.TempDir()
	u, err := Create(home, []byte(goodPassword), t0)
	if err != nil {
		t.Fatal(err)
	}
	u.Wipe()
	f, _ := Load(home)

	st := f.Meta.PasswordStatus(t0.Add(75 * 24 * time.Hour))
	if st.Expired || st.Warn || st.DaysLeft != 15 {
		t.Fatalf("day 75: %+v", st)
	}
	st = f.Meta.PasswordStatus(t0.Add(76*24*time.Hour + time.Hour))
	if st.Expired || !st.Warn || st.DaysLeft != 14 || st.WarningText() == "" {
		t.Fatalf("day 76: %+v", st)
	}
	st = f.Meta.PasswordStatus(t0.Add(90 * 24 * time.Hour))
	if !st.Expired || st.WarningText() == "" {
		t.Fatalf("day 90: %+v", st)
	}

	expired := t0.Add(91 * 24 * time.Hour)
	if _, err := f.Unlock([]byte(goodPassword), expired, UnlockOptions{}); !errors.Is(err, ErrPasswordExpired) {
		t.Fatalf("expired password unlocked: %v", err)
	}
	// The change flow may unlock an expired wallet, but needs the old password.
	if _, err := f.Unlock([]byte("wrong wrong wrong"), expired, UnlockOptions{AllowExpired: true}); !errors.Is(err, ErrWrongPassword) {
		t.Fatal("change flow without the old password")
	}
	u, err = f.Unlock([]byte(goodPassword), expired, UnlockOptions{AllowExpired: true})
	if err != nil {
		t.Fatal(err)
	}
	if err := u.ChangePassword([]byte(goodPassword), []byte(goodPassword), expired); err == nil {
		t.Fatal("same password accepted")
	}
	if err := u.ChangePassword([]byte(goodPassword), []byte("short"), expired); err == nil {
		t.Fatal("weak new password accepted")
	}
	newPW := "a brand new long passphrase"
	if err := u.ChangePassword([]byte(goodPassword), []byte(newPW), expired); err != nil {
		t.Fatal(err)
	}
	u.Wipe()
	f, _ = Load(home)
	if _, err := f.Unlock([]byte(goodPassword), expired, UnlockOptions{}); !errors.Is(err, ErrWrongPassword) {
		t.Fatal("old password still works")
	}
	u, err = f.Unlock([]byte(newPW), expired, UnlockOptions{})
	if err != nil {
		t.Fatalf("new password: %v", err)
	}
	if st := u.File.Meta.PasswordStatus(expired); st.Expired || st.DaysLeft != 90 {
		t.Fatalf("after change: %+v", st)
	}
}

func TestImportAndBackupState(t *testing.T) {
	home := t.TempDir()
	phrase := "test test test test test test test test test test test junk"
	u, err := ImportMnemonic(home, phrase, []byte(goodPassword), t0)
	if err != nil {
		t.Fatal(err)
	}
	if u.Address.Hex() != "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266" || !u.File.Meta.Backup.Confirmed || u.File.Meta.Backup.Method != "restore" {
		t.Fatalf("import: %s %+v", u.Address.Hex(), u.File.Meta.Backup)
	}
	home2 := t.TempDir()
	u2, err := ImportPrivateKey(home2, "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80", []byte(goodPassword), t0)
	if err != nil {
		t.Fatal(err)
	}
	if u2.Address != u.Address || u2.File.Kind != KindPrivateKey {
		t.Fatal("private key import gives a different address")
	}
	if _, err := ImportPrivateKey(t.TempDir(), "0x1234", []byte(goodPassword), t0); err == nil {
		t.Fatal("short key accepted")
	}

	// A fresh wallet is not backed up; the quiz confirmation is persisted and signed.
	home3 := t.TempDir()
	u3, _ := Create(home3, []byte(goodPassword), t0)
	if u3.File.Meta.Backup.Confirmed {
		t.Fatal("new wallet marked backed up")
	}
	if err := u3.RecordReveal(t0); err != nil {
		t.Fatal(err)
	}
	if err := u3.MarkBackupConfirmed(t0); err != nil {
		t.Fatal(err)
	}
	u3.Wipe()
	f3, _ := Load(home3)
	u3, err = f3.Unlock([]byte(goodPassword), t0, UnlockOptions{KeepSecret: true})
	if err != nil {
		t.Fatal(err)
	}
	if !u3.File.Meta.Backup.Confirmed || u3.File.Meta.Backup.Reveals != 1 || len(strings.Fields(u3.Secret())) != 24 {
		t.Fatalf("backup state: %+v", u3.File.Meta.Backup)
	}
}

func TestQuiz(t *testing.T) {
	phrase := strings.Repeat("abandon ", 23) + "art"
	items := QuizItems(KindMnemonic, phrase)
	if len(items) != 24 {
		t.Fatal(len(items))
	}
	for i := 0; i < 200; i++ {
		pos, err := PickPositions(3, 24)
		if err != nil || len(pos) != 3 || pos[0] < 1 || pos[2] > 24 || pos[0] >= pos[1] || pos[1] >= pos[2] {
			t.Fatalf("positions %v %v", pos, err)
		}
	}
	if !CheckAnswers(items, []int{1, 23, 24}, []string{"abandon", " Abandon ", "ART"}) {
		t.Error("correct answers refused")
	}
	if CheckAnswers(items, []int{1, 23, 24}, []string{"abandon", "abandon", "abandon"}) {
		t.Error("wrong answer accepted")
	}
	if CheckAnswers(items, []int{1, 2}, []string{"abandon"}) || CheckAnswers(items, nil, nil) || CheckAnswers(items, []int{25}, []string{"x"}) {
		t.Error("malformed quiz accepted")
	}
	keyItems := QuizItems(KindPrivateKey, "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80")
	if len(keyItems) != 16 || keyItems[0] != "ac09" || keyItems[15] != "ff80" {
		t.Fatalf("key groups %v", keyItems)
	}
	if !CheckAnswers(keyItems, []int{2, 16}, []string{"74BE", "ff 80"}) {
		t.Error("key quiz refused correct groups")
	}
}

func TestAtomicWriteNoPartialFile(t *testing.T) {
	dir := t.TempDir()
	p := filepath.Join(dir, "x.json")
	if err := WriteFileAtomic(p, []byte("one"), true); err != nil {
		t.Fatal(err)
	}
	if err := WriteFileAtomic(p, []byte("two"), true); !errors.Is(err, ErrWalletExists) {
		t.Fatalf("create over existing: %v", err)
	}
	if err := WriteFileAtomic(p, []byte("three"), false); err != nil {
		t.Fatal(err)
	}
	b, _ := os.ReadFile(p)
	entries, _ := os.ReadDir(dir)
	if string(b) != "three" || len(entries) != 1 {
		t.Fatalf("content %q entries %d", b, len(entries))
	}
}
