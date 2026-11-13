package keystore

import (
	"crypto/ecdsa"
	"crypto/rand"
	"fmt"
	"strings"

	"github.com/btcsuite/btcd/btcutil/hdkeychain"
	"github.com/btcsuite/btcd/chaincfg"
	bip39 "github.com/cosmos/go-bip39"
	"github.com/ethereum/go-ethereum/crypto"
)

// DerivationPath is the standard Ethereum (and MetaMask) account path; the same phrase imported into MetaMask
// shows the same address as its first account.
const DerivationPath = "m/44'/60'/0'/0/0"

var derivationIndexes = []uint32{
	hdkeychain.HardenedKeyStart + 44,
	hdkeychain.HardenedKeyStart + 60,
	hdkeychain.HardenedKeyStart + 0,
	0,
	0,
}

// NewMnemonic returns a fresh 24-word BIP-39 recovery phrase from 256 bits of operating-system randomness.
func NewMnemonic() (string, error) {
	entropy := make([]byte, 32)
	if _, err := rand.Read(entropy); err != nil {
		return "", fmt.Errorf("reading system randomness: %w", err)
	}
	defer zero(entropy)
	return bip39.NewMnemonic(entropy)
}

// NormalizeMnemonic lower-cases and single-spaces a typed phrase and checks every word, the word count and the
// checksum. Errors name the first unknown word so a typo is easy to find.
func NormalizeMnemonic(phrase string) (string, error) {
	words := strings.Fields(strings.ToLower(strings.TrimSpace(phrase)))
	switch len(words) {
	case 12, 15, 18, 21, 24:
	default:
		return "", fmt.Errorf("a recovery phrase has 24 words (or 12/15/18/21 from other wallets); you entered %d", len(words))
	}
	for i, w := range words {
		if _, ok := bip39.ReverseWordMap[w]; !ok {
			return "", fmt.Errorf("word %d (%q) is not a BIP-39 recovery word; check its spelling", i+1, w)
		}
	}
	norm := strings.Join(words, " ")
	if _, err := bip39.MnemonicToByteArray(norm); err != nil {
		return "", fmt.Errorf("the words are valid but their checksum is not: one word is wrong or two are swapped")
	}
	return norm, nil
}

// KeyFromMnemonic derives the account key at DerivationPath (no BIP-39 passphrase, like MetaMask).
func KeyFromMnemonic(mnemonic string) (*ecdsa.PrivateKey, error) {
	norm, err := NormalizeMnemonic(mnemonic)
	if err != nil {
		return nil, err
	}
	seed := bip39.NewSeed(norm, "")
	defer zero(seed)
	key, err := hdkeychain.NewMaster(seed, &chaincfg.MainNetParams)
	if err != nil {
		return nil, fmt.Errorf("deriving the master key: %w", err)
	}
	for _, idx := range derivationIndexes {
		next, err := key.Derive(idx)
		key.Zero()
		if err != nil {
			return nil, fmt.Errorf("deriving the account key: %w", err)
		}
		key = next
	}
	defer key.Zero()
	priv, err := key.ECPrivKey()
	if err != nil {
		return nil, err
	}
	raw := priv.Serialize() // 32 bytes, left-padded
	defer zero(raw)
	return crypto.ToECDSA(raw)
}

// KeyFromHex parses a 32-byte private key in hex (with or without 0x).
func KeyFromHex(s string) (*ecdsa.PrivateKey, error) {
	s = strings.TrimPrefix(strings.TrimPrefix(strings.TrimSpace(s), "0x"), "0X")
	if len(s) != 64 {
		return nil, fmt.Errorf("a private key is 64 hexadecimal characters (optionally starting with 0x); you entered %d characters", len(s))
	}
	k, err := crypto.HexToECDSA(s)
	if err != nil {
		return nil, fmt.Errorf("that is not a valid private key")
	}
	return k, nil
}

// WordAt returns the 1-based word of a phrase (used by the backup quiz).
func WordAt(mnemonic string, pos int) string {
	words := strings.Fields(mnemonic)
	if pos < 1 || pos > len(words) {
		return ""
	}
	return words[pos-1]
}

func zero(b []byte) {
	for i := range b {
		b[i] = 0
	}
}

// WipeKey overwrites the private scalar of a key in memory (best effort: Go may have copied it before).
func WipeKey(k *ecdsa.PrivateKey) {
	if k == nil || k.D == nil {
		return
	}
	words := k.D.Bits()
	for i := range words {
		words[i] = 0
	}
	k.D.SetInt64(0)
}
