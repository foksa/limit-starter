// Usage Window Starter: a macOS menu bar app that starts Claude and Codex 5h
// sessions as soon as the old ones reset. With a subcommand it runs as a CLI.
package main

import (
	"fmt"
	"os"
	"strings"
)

func main() {
	// The launcher starts the app without arguments; older macOS may add -psn_….
	if len(os.Args) > 1 && !strings.HasPrefix(os.Args[1], "-psn") {
		os.Exit(runCLI(os.Args[1:]))
	}
	if err := runApp(); err != nil {
		fmt.Fprintf(os.Stderr, "[usage-window-starter] %s\n", err)
		os.Exit(1)
	}
}
