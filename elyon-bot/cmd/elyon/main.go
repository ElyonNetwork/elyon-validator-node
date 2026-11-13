// Command elyon is the command-line trading client for the Elyon DEX. See README.md.
package main

import (
	"os"

	"github.com/elyon-chain/elyon-bot/internal/cli"
)

func main() { os.Exit(cli.Main(os.Args[1:])) }
