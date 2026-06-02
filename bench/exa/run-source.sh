#!/usr/bin/env bash
# run-source.sh — run unbrowse from SOURCE (src/cli.ts via bun). The exa bench
# witness uses this as UNBROWSE_BIN because unbrowse is source-only until release,
# so the gate must measure the current tree, not a stale global binary.
exec bun "$(cd "$(dirname "$0")/../.." && pwd)/src/cli.ts" "$@"
