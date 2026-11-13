package keystore

import (
	"crypto/rand"
	"fmt"
	"math/big"
	"runtime"
	"sort"
	"strings"
)

func isWindows() bool { return runtime.GOOS == "windows" }

// QuizItems splits a recovery secret into the items the backup screen shows and the quiz asks for: the words
// of a phrase, or the private key in 16 groups of 4 hexadecimal characters.
func QuizItems(kind, secretText string) []string {
	if kind == KindMnemonic {
		return strings.Fields(secretText)
	}
	s := strings.ToLower(strings.TrimPrefix(secretText, "0x"))
	var out []string
	for i := 0; i+4 <= len(s); i += 4 {
		out = append(out, s[i:i+4])
	}
	return out
}

// PickPositions returns n distinct 1-based positions out of total, chosen with system randomness, sorted.
func PickPositions(n, total int) ([]int, error) {
	if n <= 0 || total <= 0 || n > total {
		return nil, fmt.Errorf("cannot pick %d of %d", n, total)
	}
	chosen := map[int]bool{}
	for len(chosen) < n {
		r, err := rand.Int(rand.Reader, big.NewInt(int64(total)))
		if err != nil {
			return nil, err
		}
		chosen[int(r.Int64())+1] = true
	}
	out := make([]int, 0, n)
	for p := range chosen {
		out = append(out, p)
	}
	sort.Ints(out)
	return out, nil
}

// CheckAnswers verifies the quiz: answers[i] must equal items[positions[i]-1] (case-insensitive, spaces ignored).
func CheckAnswers(items []string, positions []int, answers []string) bool {
	if len(positions) == 0 || len(positions) != len(answers) {
		return false
	}
	ok := true
	for i, p := range positions {
		if p < 1 || p > len(items) {
			return false
		}
		got := strings.ToLower(strings.Join(strings.Fields(answers[i]), ""))
		want := strings.ToLower(items[p-1])
		// Evaluate every answer (no early exit) so timing does not reveal which one was wrong.
		if got != want {
			ok = false
		}
	}
	return ok
}
