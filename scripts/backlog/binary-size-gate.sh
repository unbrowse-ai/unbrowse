#!/usr/bin/env bash
# binary-size-gate.sh — witness for binary-slim: the production binary build
# minifies by default, measurably shrinking the embedded bundle. Builds the
# bundle plain vs minified (fast; no --compile) and asserts a real reduction,
# and that build-binaries.sh defaults minify ON.
set -uo pipefail
REPO="$(cd "$(dirname "$0")/../.." && pwd)"; cd "$REPO"

grep -qE 'UNBROWSE_BUILD_MINIFY:-1' scripts/build-binaries.sh \
  || { echo "FAIL: build-binaries.sh does not default minify ON"; exit 1; }

tmp=$(mktemp -d)
bun build src/single-binary.ts --target=bun --outdir="$tmp/plain" >/dev/null 2>&1 || { echo "FAIL: plain bundle build"; exit 1; }
bun build src/single-binary.ts --target=bun --minify --outdir="$tmp/min" >/dev/null 2>&1 || { echo "FAIL: minified bundle build"; exit 1; }
plain=$(wc -c < "$tmp/plain/single-binary.js")
min=$(wc -c < "$tmp/min/single-binary.js")
rm -rf "$tmp"
[ "$min" -gt 0 ] && [ "$plain" -gt 0 ] || { echo "FAIL: empty bundle"; exit 1; }
# require the minified bundle to be at least 20% smaller
pct=$(( (plain - min) * 100 / plain ))
echo "bundle: plain=$((plain/1024))K min=$((min/1024))K  reduction=${pct}%"
[ "$pct" -ge 20 ] || { echo "FAIL: minify reduction <20% (${pct}%)"; exit 1; }
echo "ok: production binary minifies by default; embedded bundle ${pct}% smaller"
