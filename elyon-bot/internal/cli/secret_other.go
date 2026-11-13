//go:build !linux && !darwin && !windows

package cli

import (
	"fmt"
	"io"

	"golang.org/x/term"
)

// readSecret on other systems (BSDs…): hidden input through x/term, without the type-ahead flush.
func readSecret(fd int, prompt string, out io.Writer) ([]byte, error) {
	state, err := term.GetState(fd)
	if err == nil {
		stop := restoreOnSignal(func() { _ = term.Restore(fd, state) })
		defer stop()
	}
	fmt.Fprint(out, prompt)
	b, err := term.ReadPassword(fd)
	fmt.Fprintln(out)
	return b, err
}
