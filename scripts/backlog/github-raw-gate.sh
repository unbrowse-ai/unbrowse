#!/usr/bin/env bash
# github-raw-gate.sh — witness for github-raw-extract.
#
# The node (the d51 structured-file extraction gap, atomic sub-lever): for a
# github code-FILE /blob/ URL, `unbrowse fetch` should pull the CLEAN RAW file
# (raw.githubusercontent), not the chrome-heavy rendered blob page — the
# authoritative content is one URL away. Verifies:
#   1. the helper + the fetch wiring (cli.ts) build,
#   2. githubBlobToRaw maps blob views → raw files, returns null for non-file
#      views (PR/issue/tree) + non-github URLs, and the raw source returns the
#      clean file content (chrome-free) — via the test.
set -uo pipefail
cd "$(dirname "$0")/../.."

tmp=$(mktemp -d); trap 'rm -rf "$tmp"' EXIT
if ! bun build src/extraction/github-raw.ts src/cli.ts --target=node --outdir="$tmp" >/dev/null 2>&1; then
  echo "github-raw-gate: FAIL — github-raw / cli fetch wiring does not build"; exit 1
fi

if ! bun test tests/github-raw.test.ts >/dev/null 2>&1; then
  echo "github-raw-gate: FAIL — github-raw test red"; exit 1
fi

echo "github-raw-gate: ok — github code-file blob URLs fetch the clean raw file (chrome-free), non-file views pass through"
exit 0
