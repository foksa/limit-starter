#!/bin/sh
# Run the Go toolchain Hutch installed for Electrobun (or `go` from PATH).
set -eu
cd "$(dirname "$0")/.."
go=$(ls -d "$HOME"/.hutch/toolchains/go/*/*/bin/go 2>/dev/null | sort -V | tail -1)
exec "${go:-go}" "$@"
