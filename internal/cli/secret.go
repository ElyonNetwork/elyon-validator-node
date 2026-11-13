package cli

import (
	"fmt"
	"os"
	"os/signal"
	"syscall"
)

// maxSecretLen bounds a typed password or recovery phrase.
const maxSecretLen = 4096

// restoreOnSignal makes sure Ctrl+C (or SIGTERM) during a hidden prompt gives the terminal its echo back before
// the program exits. It returns a function that removes the handler.
func restoreOnSignal(restore func()) func() {
	c := make(chan os.Signal, 1)
	signal.Notify(c, os.Interrupt, syscall.SIGTERM)
	done := make(chan struct{})
	go func() {
		select {
		case <-c:
			restore()
			fmt.Fprintln(os.Stderr)
			os.Exit(130)
		case <-done:
		}
	}()
	return func() {
		signal.Stop(c)
		close(done)
	}
}
