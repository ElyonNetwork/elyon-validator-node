// Package version holds the build version of elyon-bot. The values are set at build time with
// -ldflags "-X github.com/elyon-chain/elyon-bot/internal/version.Version=..." (see scripts/build.sh).
package version

import (
	"fmt"
	"runtime"
	"runtime/debug"
)

var (
	// Version is the release version, e.g. "0.1.0".
	Version = "0.1.1-dev"
	// Commit is the git commit the binary was built from.
	Commit = ""
	// Date is the build date (UTC, RFC 3339).
	Date = ""
)

// UserAgent is sent with every HTTP request to the Elyon RPC and the DEX API.
func UserAgent() string { return "elyon-bot/" + Version }

// CommitOrVCS returns the embedded commit, or the VCS revision recorded by the Go toolchain.
func CommitOrVCS() string {
	if Commit != "" {
		return Commit
	}
	if info, ok := debug.ReadBuildInfo(); ok {
		for _, s := range info.Settings {
			if s.Key == "vcs.revision" && len(s.Value) >= 12 {
				return s.Value[:12]
			}
		}
	}
	return "unknown"
}

// String is the one-line version shown by `elyon version`.
func String() string {
	date := Date
	if date == "" {
		date = "unknown date"
	}
	return fmt.Sprintf("elyon %s (commit %s, built %s, %s, %s/%s)", Version, CommitOrVCS(), date, runtime.Version(), runtime.GOOS, runtime.GOARCH)
}
