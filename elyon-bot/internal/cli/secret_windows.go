//go:build windows

package cli

import (
	"fmt"
	"io"

	"golang.org/x/sys/windows"
	"golang.org/x/term"
)

// readSecret discards anything typed before the prompt (it was shown in clear), prints the prompt and reads one
// line with echo switched off (Windows console). The console mode is restored on return and on Ctrl+C.
func readSecret(fd int, prompt string, out io.Writer) ([]byte, error) {
	h := windows.Handle(fd)
	var mode uint32
	if err := windows.GetConsoleMode(h, &mode); err != nil {
		return nil, err
	}
	_ = windows.FlushConsoleInputBuffer(h)
	stop := restoreOnSignal(func() { _ = windows.SetConsoleMode(h, mode) })
	defer stop()
	fmt.Fprint(out, prompt)
	b, err := term.ReadPassword(fd)
	fmt.Fprintln(out)
	return b, err
}
