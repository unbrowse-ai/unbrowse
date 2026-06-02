#!/usr/bin/env bash
# fetch-readable-gate.sh — witness for fetch-readable-mode.
#
# The node: `unbrowse fetch --main` strips page chrome (nav/sidebar/footer/ads)
# and isolates the main content region before markdown conversion, raising
# extraction fidelity — the concrete gap the exa micro-benchmark measured
# (unbrowse fetch = 0.74 ROUGE-L vs Exa 0.828, due to ~50% chrome noise). Wires
# the already-present cleanDOM into fetch (was unused there). Verifies:
#   1. the readable-markdown module + cli wiring build,
#   2. readable extraction keeps main content, drops chrome, and raises ROUGE-L
#      fidelity vs whole-page conversion, with a safe fallback — via the test.
set -uo pipefail
cd "$(dirname "$0")/../.."

tmp=$(mktemp -d); trap 'rm -rf "$tmp"' EXIT
if ! bun build src/extraction/readable-markdown.ts src/cli.ts --target=node --outdir="$tmp" >/dev/null 2>&1; then
  echo "fetch-readable-gate: FAIL — readable-markdown / cli wiring does not build"; exit 1
fi

if ! bun test tests/readable-markdown.test.ts >/dev/null 2>&1; then
  echo "fetch-readable-gate: FAIL — readable-markdown test red"; exit 1
fi

echo "fetch-readable-gate: ok — fetch --main strips chrome + isolates main content, raising ROUGE-L fidelity (safe fallback when no main region)"
exit 0
