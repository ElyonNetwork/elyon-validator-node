// Package keystore stores the trading key on the user's machine, encrypted with the user's password.
//
// Format (wallet.json, file mode 0600):
//   - the secret (the 24-word recovery phrase, or a raw private key for imported keys) is encrypted with
//     AES-256-GCM under a key derived from the password with scrypt (N=2^18, r=8, p=1, 32-byte key, random salt);
//     the GCM additional data binds the ciphertext to the wallet address and kind;
//   - the address and the settings that must not be changed by someone without the password (password age
//     policy, backup state, transfer allowlist, daily limits) are stored in clear but authenticated with an
//     HMAC-SHA256 whose key is derived (HKDF) from the private key: a modified file is detected at unlock.
//
// The password itself is never stored anywhere. Without it the file reveals only the address.
package keystore

import (
	"crypto/aes"
	"crypto/cipher"
	"crypto/ecdsa"
	"crypto/hkdf"
	"crypto/hmac"
	"crypto/rand"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"time"
	"unicode"
	"unicode/utf8"

	"github.com/ethereum/go-ethereum/common"
	"github.com/ethereum/go-ethereum/crypto"
	"golang.org/x/crypto/scrypt"
)

const (
	// FileName is the wallet file inside the elyon home directory.
	FileName = "wallet.json"
	// FormatName identifies the file format.
	FormatName = "elyon-bot-wallet"
	// FormatVersion is the current format version.
	FormatVersion = 1

	KindMnemonic   = "mnemonic"
	KindPrivateKey = "private-key"

	// MinPasswordLength is the shortest password accepted.
	MinPasswordLength = 12
	// DefaultMaxAgeDays is how long a password stays valid before it must be changed.
	DefaultMaxAgeDays = 90
	// WarnDays is how many days before expiry the user is warned.
	WarnDays = 14
	// MinMaxAgeDays and MaxMaxAgeDays bound the configurable maximum password age.
	MinMaxAgeDays = 7
	MaxMaxAgeDays = 365
)

// Scrypt parameters. ScryptN is a variable only so tests can run quickly; production code never changes it.
var (
	ScryptN = 1 << 18
	ScryptR = 8
	ScryptP = 1
)

const scryptDKLen = 32

var (
	ErrNoWallet        = errors.New("no wallet yet: run `elyon setup` (or `elyon wallet create` / `elyon wallet restore`)")
	ErrWalletExists    = errors.New("a wallet already exists in this elyon home; it is never overwritten (use another --home, or move the old wallet.json away yourself if you are sure)")
	ErrWrongPassword   = errors.New("wrong password")
	ErrPasswordExpired = errors.New("your password has expired: run `elyon password change` (it asks for the old password) and then unlock again")
	ErrTampered        = errors.New("the wallet file was modified outside elyon (its settings no longer match its signature); do not use it: restore your wallet from the recovery phrase into a fresh --home")
)

// File is the on-disk wallet.
type File struct {
	Format  string        `json:"format"`
	Version int           `json:"version"`
	Address string        `json:"address"`
	Kind    string        `json:"kind"`
	Crypto  CryptoSection `json:"crypto"`
	Meta    Meta          `json:"meta"`
	MetaMAC string        `json:"meta_mac"`

	path string
}

// CryptoSection holds the encrypted secret.
type CryptoSection struct {
	KDF        string    `json:"kdf"`
	KDFParams  KDFParams `json:"kdfparams"`
	Cipher     string    `json:"cipher"`
	Nonce      string    `json:"nonce"`
	Ciphertext string    `json:"ciphertext"`
}

// KDFParams are the scrypt parameters used for this file.
type KDFParams struct {
	N     int    `json:"n"`
	R     int    `json:"r"`
	P     int    `json:"p"`
	DKLen int    `json:"dklen"`
	Salt  string `json:"salt"`
}

// Meta are the authenticated (HMAC) settings of the wallet.
type Meta struct {
	CreatedAt          time.Time    `json:"created_at"`
	PasswordChangedAt  time.Time    `json:"password_changed_at"`
	PasswordMaxAgeDays int          `json:"password_max_age_days"`
	Backup             Backup       `json:"backup"`
	Allowlist          []AllowEntry `json:"allowlist"`
	DailyLimits        []DailyLimit `json:"daily_limits"`
}

// Backup records whether the user proved they wrote the recovery secret down.
type Backup struct {
	Confirmed    bool       `json:"confirmed"`
	ConfirmedAt  *time.Time `json:"confirmed_at,omitempty"`
	Method       string     `json:"method,omitempty"` // "quiz" or "restore"
	Reveals      int        `json:"reveals"`
	LastRevealAt *time.Time `json:"last_reveal_at,omitempty"`
}

// AllowEntry is a transfer destination the user approved with the password.
type AllowEntry struct {
	Address string    `json:"address"`
	Label   string    `json:"label,omitempty"`
	AddedAt time.Time `json:"added_at"`
}

// DailyLimit caps transfers of one token per rolling 24 hours.
type DailyLimit struct {
	Token    string `json:"token"` // lower-case token address, or "native" for ELN
	Symbol   string `json:"symbol"`
	Decimals int    `json:"decimals"`
	Amount   string `json:"amount"` // base units
}

type secret struct {
	Mnemonic   string `json:"mnemonic,omitempty"`
	Path       string `json:"path,omitempty"`
	PrivateKey string `json:"private_key,omitempty"`
}

// Unlocked is a decrypted wallet. Call Wipe when done.
type Unlocked struct {
	File    *File
	Key     *ecdsa.PrivateKey
	Address common.Address

	macKey []byte
	phrase string // kept only when requested (backup)
}

// Path returns the wallet file path inside home.
func Path(home string) string { return filepath.Join(home, FileName) }

// Exists reports whether a wallet file exists in home.
func Exists(home string) bool {
	_, err := os.Stat(Path(home))
	return err == nil
}

// ValidatePassword enforces the password policy for new passwords.
func ValidatePassword(pw []byte) error {
	if !utf8.Valid(pw) {
		return errors.New("the password must be valid text (UTF-8)")
	}
	n := utf8.RuneCount(pw)
	if n < MinPasswordLength {
		return fmt.Errorf("the password must have at least %d characters (it has %d); a short sentence is a good choice", MinPasswordLength, n)
	}
	s := string(pw)
	if strings.TrimSpace(s) != s {
		return errors.New("the password must not start or end with a space")
	}
	distinct := map[rune]bool{}
	for _, r := range s {
		distinct[unicode.ToLower(r)] = true
	}
	if len(distinct) < 5 {
		return errors.New("the password repeats too few different characters; use at least 5 different characters")
	}
	lower := strings.ToLower(s)
	for _, weak := range []string{"123456789012", "password1234", "qwertyuiopas", "elyonelyonelyon", "aaaaaaaaaaaa"} {
		if strings.Contains(lower, weak) {
			return errors.New("the password is too easy to guess; choose something less predictable")
		}
	}
	return nil
}

// Create makes a new wallet with a fresh 24-word phrase. It returns the unlocked wallet (with the phrase kept for
// the immediate backup) and never overwrites an existing file.
func Create(home string, password []byte, now time.Time) (*Unlocked, error) {
	phrase, err := NewMnemonic()
	if err != nil {
		return nil, err
	}
	return save(home, password, now, KindMnemonic, phrase, Backup{})
}

// ImportMnemonic stores an existing recovery phrase. The backup counts as confirmed: the user just typed it.
func ImportMnemonic(home string, phrase string, password []byte, now time.Time) (*Unlocked, error) {
	norm, err := NormalizeMnemonic(phrase)
	if err != nil {
		return nil, err
	}
	t := now.UTC().Truncate(time.Second)
	return save(home, password, now, KindMnemonic, norm, Backup{Confirmed: true, ConfirmedAt: &t, Method: "restore"})
}

// ImportPrivateKey stores an existing raw private key.
func ImportPrivateKey(home string, hexKey string, password []byte, now time.Time) (*Unlocked, error) {
	k, err := KeyFromHex(hexKey)
	if err != nil {
		return nil, err
	}
	raw := hex.EncodeToString(crypto.FromECDSA(k))
	WipeKey(k)
	t := now.UTC().Truncate(time.Second)
	return save(home, password, now, KindPrivateKey, raw, Backup{Confirmed: true, ConfirmedAt: &t, Method: "restore"})
}

func save(home string, password []byte, now time.Time, kind, secretValue string, backup Backup) (*Unlocked, error) {
	if err := ValidatePassword(password); err != nil {
		return nil, err
	}
	if Exists(home) {
		return nil, ErrWalletExists
	}
	var key *ecdsa.PrivateKey
	var err error
	s := secret{}
	if kind == KindMnemonic {
		key, err = KeyFromMnemonic(secretValue)
		s.Mnemonic, s.Path = secretValue, DerivationPath
	} else {
		key, err = KeyFromHex(secretValue)
		s.PrivateKey = secretValue
	}
	if err != nil {
		return nil, err
	}
	addr := crypto.PubkeyToAddress(key.PublicKey)
	t := now.UTC().Truncate(time.Second)
	f := &File{
		Format:  FormatName,
		Version: FormatVersion,
		Address: addr.Hex(),
		Kind:    kind,
		Meta: Meta{
			CreatedAt:          t,
			PasswordChangedAt:  t,
			PasswordMaxAgeDays: DefaultMaxAgeDays,
			Backup:             backup,
			Allowlist:          []AllowEntry{},
			DailyLimits:        []DailyLimit{},
		},
		path: Path(home),
	}
	if err := f.encrypt(password, s); err != nil {
		return nil, err
	}
	u := &Unlocked{File: f, Key: key, Address: addr, macKey: deriveMACKey(key)}
	if kind == KindMnemonic {
		u.phrase = s.Mnemonic
	} else {
		u.phrase = s.PrivateKey
	}
	if err := os.MkdirAll(home, 0o700); err != nil {
		return nil, err
	}
	if err := u.write(true); err != nil {
		return nil, err
	}
	return u, nil
}

// Load reads and checks the structure of the wallet file (no password needed).
func Load(home string) (*File, error) {
	p := Path(home)
	b, err := os.ReadFile(p)
	if errors.Is(err, os.ErrNotExist) {
		return nil, ErrNoWallet
	}
	if err != nil {
		return nil, fmt.Errorf("reading %s: %w", p, err)
	}
	var f File
	if err := json.Unmarshal(b, &f); err != nil {
		return nil, fmt.Errorf("%s is not a valid elyon wallet file: %w", p, err)
	}
	if f.Format != FormatName || f.Version != FormatVersion {
		return nil, fmt.Errorf("%s is not an elyon wallet file of a supported version", p)
	}
	if !common.IsHexAddress(f.Address) || (f.Kind != KindMnemonic && f.Kind != KindPrivateKey) {
		return nil, fmt.Errorf("%s is damaged (address or kind)", p)
	}
	if f.Crypto.KDF != "scrypt" || f.Crypto.Cipher != "aes-256-gcm" {
		return nil, fmt.Errorf("%s uses an unsupported encryption", p)
	}
	f.path = p
	return &f, nil
}

// AddressValue returns the address recorded in the file. It is only verified against the key at unlock.
func (f *File) AddressValue() common.Address { return common.HexToAddress(f.Address) }

// PasswordState describes the password age policy at a given time.
type PasswordState struct {
	ChangedAt  time.Time `json:"changed_at"`
	MaxAgeDays int       `json:"max_age_days"`
	ExpiresAt  time.Time `json:"expires_at"`
	DaysLeft   int       `json:"days_left"`
	Expired    bool      `json:"expired"`
	Warn       bool      `json:"warn"`
}

// PasswordStatus computes the password age state.
func (m Meta) PasswordStatus(now time.Time) PasswordState {
	maxAge := m.PasswordMaxAgeDays
	if maxAge < MinMaxAgeDays || maxAge > MaxMaxAgeDays {
		maxAge = DefaultMaxAgeDays
	}
	exp := m.PasswordChangedAt.Add(time.Duration(maxAge) * 24 * time.Hour)
	left := exp.Sub(now)
	days := int(left.Hours() / 24)
	if left > 0 && left%(24*time.Hour) != 0 {
		days++ // "1 day left" until the very last moment
	}
	if left <= 0 {
		days = 0
	}
	return PasswordState{ChangedAt: m.PasswordChangedAt, MaxAgeDays: maxAge, ExpiresAt: exp, DaysLeft: days, Expired: left <= 0, Warn: left > 0 && days <= WarnDays}
}

// WarningText returns the password warning to show the user, or "".
func (s PasswordState) WarningText() string {
	switch {
	case s.Expired:
		return "Your password has expired. Run `elyon password change` to set a new one."
	case s.Warn:
		unit := "days"
		if s.DaysLeft == 1 {
			unit = "day"
		}
		return fmt.Sprintf("Your password expires in %d %s (%s). Run `elyon password change` before then, or the wallet will refuse to unlock.", s.DaysLeft, unit, s.ExpiresAt.Format("2006-01-02"))
	}
	return ""
}

// UnlockOptions changes what Unlock allows.
type UnlockOptions struct {
	// AllowExpired is used only by the password change flow.
	AllowExpired bool
	// KeepSecret keeps the recovery phrase / private key text in memory (backup flow only).
	KeepSecret bool
}

// Unlock decrypts the wallet. It refuses an expired password (unless AllowExpired), a wrong password and a file
// whose authenticated settings were modified.
func (f *File) Unlock(password []byte, now time.Time, opt UnlockOptions) (*Unlocked, error) {
	pt, err := f.decrypt(password)
	if err != nil {
		return nil, err
	}
	defer zero(pt)
	var s secret
	if err := json.Unmarshal(pt, &s); err != nil {
		return nil, fmt.Errorf("the decrypted wallet is damaged: %w", err)
	}
	var key *ecdsa.PrivateKey
	if f.Kind == KindMnemonic {
		key, err = KeyFromMnemonic(s.Mnemonic)
	} else {
		key, err = KeyFromHex(s.PrivateKey)
	}
	if err != nil {
		return nil, fmt.Errorf("the decrypted wallet is damaged: %w", err)
	}
	addr := crypto.PubkeyToAddress(key.PublicKey)
	if addr != f.AddressValue() {
		WipeKey(key)
		return nil, ErrTampered
	}
	u := &Unlocked{File: f, Key: key, Address: addr, macKey: deriveMACKey(key)}
	if !u.metaValid() {
		u.Wipe()
		return nil, ErrTampered
	}
	if !opt.AllowExpired && f.Meta.PasswordStatus(now).Expired {
		u.Wipe()
		return nil, ErrPasswordExpired
	}
	if opt.KeepSecret {
		if f.Kind == KindMnemonic {
			u.phrase = s.Mnemonic
		} else {
			u.phrase = s.PrivateKey
		}
	}
	return u, nil
}

// VerifyPassword checks a password without keeping anything unlocked (used for password-gated requests).
func (f *File) VerifyPassword(password []byte) error {
	pt, err := f.decrypt(password)
	if err != nil {
		return err
	}
	zero(pt)
	return nil
}

// Secret returns the recovery phrase (or private key hex) when the wallet was unlocked with KeepSecret.
func (u *Unlocked) Secret() string { return u.phrase }

// Wipe erases the key material held in memory (best effort).
func (u *Unlocked) Wipe() {
	if u == nil {
		return
	}
	WipeKey(u.Key)
	u.Key = nil
	zero(u.macKey)
	u.macKey = nil
	u.phrase = ""
}

// MetaValidFor re-reads the file from disk and checks its settings signature with this unlocked key. The daemon
// uses it before honouring the allowlist or limits, so a file edited behind its back is never trusted.
func (u *Unlocked) Reload() error {
	home := filepath.Dir(u.File.path)
	f, err := Load(home)
	if err != nil {
		return err
	}
	if f.AddressValue() != u.Address {
		return ErrTampered
	}
	next := &Unlocked{File: f, Key: u.Key, Address: u.Address, macKey: u.macKey}
	if !next.metaValid() {
		return ErrTampered
	}
	u.File = f
	return nil
}

// SaveMeta signs and atomically writes the current settings (and the unchanged encrypted secret).
func (u *Unlocked) SaveMeta() error { return u.write(false) }

// ChangePassword re-encrypts the secret under a new password with a new salt and nonce.
func (u *Unlocked) ChangePassword(oldPassword, newPassword []byte, now time.Time) error {
	if err := ValidatePassword(newPassword); err != nil {
		return err
	}
	if string(oldPassword) == string(newPassword) {
		return errors.New("the new password must be different from the old one")
	}
	pt, err := u.File.decrypt(oldPassword)
	if err != nil {
		return err
	}
	defer zero(pt)
	var s secret
	if err := json.Unmarshal(pt, &s); err != nil {
		return err
	}
	if err := u.File.encrypt(newPassword, s); err != nil {
		return err
	}
	u.File.Meta.PasswordChangedAt = now.UTC().Truncate(time.Second)
	return u.write(false)
}

// MarkBackupConfirmed records a passed backup quiz.
func (u *Unlocked) MarkBackupConfirmed(now time.Time) error {
	t := now.UTC().Truncate(time.Second)
	u.File.Meta.Backup.Confirmed = true
	u.File.Meta.Backup.ConfirmedAt = &t
	u.File.Meta.Backup.Method = "quiz"
	return u.write(false)
}

// RecordReveal counts one display of the recovery secret.
func (u *Unlocked) RecordReveal(now time.Time) error {
	t := now.UTC().Truncate(time.Second)
	u.File.Meta.Backup.Reveals++
	u.File.Meta.Backup.LastRevealAt = &t
	return u.write(false)
}

// ---------------------------------------------------------------- internals

func deriveMACKey(k *ecdsa.PrivateKey) []byte {
	raw := crypto.FromECDSA(k)
	defer zero(raw)
	key, err := hkdf.Key(sha256.New, raw, []byte("elyon-bot"), "wallet-meta-mac-v1", 32)
	if err != nil {
		panic(err) // only fails for invalid lengths, which cannot happen here
	}
	return key
}

func (f *File) macInput() []byte {
	b, _ := json.Marshal(struct {
		Address string `json:"address"`
		Kind    string `json:"kind"`
		Meta    Meta   `json:"meta"`
	}{strings.ToLower(f.Address), f.Kind, f.Meta})
	return b
}

func (u *Unlocked) sign() {
	m := hmac.New(sha256.New, u.macKey)
	m.Write(u.File.macInput())
	u.File.MetaMAC = hex.EncodeToString(m.Sum(nil))
}

func (u *Unlocked) metaValid() bool {
	want, err := hex.DecodeString(u.File.MetaMAC)
	if err != nil {
		return false
	}
	m := hmac.New(sha256.New, u.macKey)
	m.Write(u.File.macInput())
	return hmac.Equal(m.Sum(nil), want)
}

func (f *File) aad() []byte {
	return []byte("elyon-bot-wallet/v1|" + strings.ToLower(f.Address) + "|" + f.Kind)
}

func (f *File) encrypt(password []byte, s secret) error {
	salt := make([]byte, 32)
	if _, err := rand.Read(salt); err != nil {
		return err
	}
	dk, err := scrypt.Key(password, salt, ScryptN, ScryptR, ScryptP, scryptDKLen)
	if err != nil {
		return err
	}
	defer zero(dk)
	block, err := aes.NewCipher(dk)
	if err != nil {
		return err
	}
	gcm, err := cipher.NewGCM(block)
	if err != nil {
		return err
	}
	nonce := make([]byte, gcm.NonceSize())
	if _, err := rand.Read(nonce); err != nil {
		return err
	}
	pt, err := json.Marshal(s)
	if err != nil {
		return err
	}
	defer zero(pt)
	ct := gcm.Seal(nil, nonce, pt, f.aad())
	f.Crypto = CryptoSection{
		KDF:        "scrypt",
		KDFParams:  KDFParams{N: ScryptN, R: ScryptR, P: ScryptP, DKLen: scryptDKLen, Salt: hex.EncodeToString(salt)},
		Cipher:     "aes-256-gcm",
		Nonce:      hex.EncodeToString(nonce),
		Ciphertext: hex.EncodeToString(ct),
	}
	return nil
}

func (f *File) decrypt(password []byte) ([]byte, error) {
	p := f.Crypto.KDFParams
	if p.N < 1<<14 || p.N > 1<<22 || p.R < 1 || p.R > 32 || p.P < 1 || p.P > 16 || p.DKLen != scryptDKLen {
		return nil, errors.New("the wallet file has unsafe or unsupported encryption parameters")
	}
	salt, err1 := hex.DecodeString(p.Salt)
	nonce, err2 := hex.DecodeString(f.Crypto.Nonce)
	ct, err3 := hex.DecodeString(f.Crypto.Ciphertext)
	if err1 != nil || err2 != nil || err3 != nil || len(salt) < 16 {
		return nil, errors.New("the wallet file is damaged (encrypted data)")
	}
	dk, err := scrypt.Key(password, salt, p.N, p.R, p.P, p.DKLen)
	if err != nil {
		return nil, err
	}
	defer zero(dk)
	block, err := aes.NewCipher(dk)
	if err != nil {
		return nil, err
	}
	gcm, err := cipher.NewGCM(block)
	if err != nil {
		return nil, err
	}
	if len(nonce) != gcm.NonceSize() {
		return nil, errors.New("the wallet file is damaged (nonce)")
	}
	pt, err := gcm.Open(nil, nonce, ct, f.aad())
	if err != nil {
		// GCM cannot tell a wrong password from a modified ciphertext/address; both mean "do not use".
		return nil, ErrWrongPassword
	}
	return pt, nil
}

func (u *Unlocked) write(create bool) error {
	u.sign()
	b, err := json.MarshalIndent(u.File, "", "  ")
	if err != nil {
		return err
	}
	return WriteFileAtomic(u.File.path, append(b, '\n'), create)
}

// WriteFileAtomic writes data with mode 0600 through a temporary file and a rename, so a crash never leaves a
// half-written file. With create=true it fails if the file already exists.
func WriteFileAtomic(path string, data []byte, create bool) error {
	dir := filepath.Dir(path)
	if create {
		if _, err := os.Stat(path); err == nil {
			return ErrWalletExists
		}
	}
	tmp, err := os.CreateTemp(dir, ".tmp-"+filepath.Base(path)+"-*")
	if err != nil {
		return err
	}
	name := tmp.Name()
	defer os.Remove(name)
	if err := tmp.Chmod(0o600); err != nil && !isWindows() {
		tmp.Close()
		return err
	}
	if _, err := tmp.Write(data); err != nil {
		tmp.Close()
		return err
	}
	if err := tmp.Sync(); err != nil {
		tmp.Close()
		return err
	}
	if err := tmp.Close(); err != nil {
		return err
	}
	if create {
		// Link fails if the target appeared meanwhile; fall back to rename on systems without hard links.
		if err := os.Link(name, path); err == nil {
			return nil
		} else if _, statErr := os.Stat(path); statErr == nil {
			return ErrWalletExists
		}
	}
	return os.Rename(name, path)
}
