package cli

import (
	"encoding/json"
	"os"
	"testing"
)

// TestMain lets tests run the real command line in a child process (see tty_linux_test.go): when
// ELYON_CLI_TEST_MAIN=1 the test binary behaves exactly like `elyon <args>`.
func TestMain(m *testing.M) {
	if os.Getenv("ELYON_CLI_TEST_MAIN") == "1" {
		var args []string
		_ = json.Unmarshal([]byte(os.Getenv("ELYON_CLI_TEST_ARGS")), &args)
		os.Exit(Main(args))
	}
	os.Exit(m.Run())
}
