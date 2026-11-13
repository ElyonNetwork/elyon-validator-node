//go:build linux || darwin

package cli

import (
	"errors"
	"fmt"
	"io"

	"golang.org/x/sys/unix"
)

// readSecret reads one line from the terminal fd with echo switched off.
//
// Order matters: echo is switched off — and anything typed before the prompt (type-ahead, which the terminal has
// already displayed in clear) is discarded, like readpassphrase(3) does — BEFORE the prompt is printed. So the
// password is only ever accepted when it was typed while invisible, and it is never echoed. The terminal state is
// restored on return and on Ctrl+C.
func readSecret(fd int, prompt string, out io.Writer) ([]byte, error) {
	old, err := unix.IoctlGetTermios(fd, ioctlGetTermios)
	if err != nil {
		return nil, err
	}
	st := *old
	st.Lflag &^= unix.ECHO | unix.ECHOE | unix.ECHOK | unix.ECHONL
	st.Lflag |= unix.ICANON | unix.ISIG
	st.Iflag |= unix.ICRNL
	if err := unix.IoctlSetTermios(fd, ioctlSetTermiosFlush, &st); err != nil {
		return nil, err
	}
	restore := func() { _ = unix.IoctlSetTermios(fd, ioctlSetTermios, old) }
	stop := restoreOnSignal(restore)
	defer stop()
	defer restore()

	fmt.Fprint(out, prompt)
	line, err := readTerminalLine(fd)
	fmt.Fprintln(out)
	return line, err
}

// readTerminalLine reads up to a newline (canonical mode: the terminal already handled backspace).
func readTerminalLine(fd int) ([]byte, error) {
	var line []byte
	var b [1]byte
	for {
		n, err := unix.Read(fd, b[:])
		if errors.Is(err, unix.EINTR) {
			continue
		}
		if err != nil {
			return nil, err
		}
		if n == 0 {
			if len(line) > 0 {
				return line, nil
			}
			return nil, io.EOF
		}
		switch b[0] {
		case '\n':
			return line, nil
		case '\r':
			continue
		}
		if len(line) >= maxSecretLen {
			return nil, errors.New("input too long")
		}
		line = append(line, b[0])
	}
}
