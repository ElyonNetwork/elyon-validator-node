// Package apitoken manages the bearer token of the local HTTP API: 32 random bytes from the operating system,
// stored in its own file (api-token, mode 0600) in the elyon home, separate from the wallet.
package apitoken

import (
	"crypto/rand"
	"crypto/sha256"
	"crypto/subtle"
	"encoding/base64"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"

	"github.com/elyon-chain/elyon-bot/internal/keystore"
)

// Prefix makes tokens recognisable (secret scanners, logs).
const Prefix = "elyon_"

// Path is the token file in home.
func Path(home string) string { return filepath.Join(home, "api-token") }

// Generate returns a new random token.
func Generate() (string, error) {
	b := make([]byte, 32)
	if _, err := rand.Read(b); err != nil {
		return "", err
	}
	return Prefix + base64.RawURLEncoding.EncodeToString(b), nil
}

// Load reads the token (trimmed).
func Load(home string) (string, error) {
	b, err := os.ReadFile(Path(home))
	if err != nil {
		return "", err
	}
	t := strings.TrimSpace(string(b))
	if !strings.HasPrefix(t, Prefix) || len(t) < len(Prefix)+40 {
		return "", errors.New("the api-token file is damaged; create a new one with `elyon api-token rotate`")
	}
	return t, nil
}

// Ensure returns the existing token or creates one. created reports a new token.
func Ensure(home string) (token string, created bool, err error) {
	if t, err := Load(home); err == nil {
		return t, false, nil
	} else if !errors.Is(err, os.ErrNotExist) {
		return "", false, err
	}
	t, err := Generate()
	if err != nil {
		return "", false, err
	}
	if err := keystore.WriteFileAtomic(Path(home), []byte(t+"\n"), true); err != nil {
		return "", false, fmt.Errorf("saving the API token: %w", err)
	}
	return t, true, nil
}

// Rotate replaces the token.
func Rotate(home string) (string, error) {
	t, err := Generate()
	if err != nil {
		return "", err
	}
	return t, keystore.WriteFileAtomic(Path(home), []byte(t+"\n"), false)
}

// Equal compares a presented token with the expected one in constant time (hashes first, so neither the
// content nor the length leaks through timing).
func Equal(presented, expected string) bool {
	a := sha256.Sum256([]byte(presented))
	b := sha256.Sum256([]byte(expected))
	return subtle.ConstantTimeCompare(a[:], b[:]) == 1 && expected != ""
}
