//go:build darwin

package cli

import "golang.org/x/sys/unix"

const (
	ioctlGetTermios      = unix.TIOCGETA
	ioctlSetTermios      = unix.TIOCSETA
	ioctlSetTermiosFlush = unix.TIOCSETAF // set and discard pending input
)
