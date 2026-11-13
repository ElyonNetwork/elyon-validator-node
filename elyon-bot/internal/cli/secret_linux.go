//go:build linux

package cli

import "golang.org/x/sys/unix"

const (
	ioctlGetTermios      = unix.TCGETS
	ioctlSetTermios      = unix.TCSETS
	ioctlSetTermiosFlush = unix.TCSETSF // set and discard pending input
)
