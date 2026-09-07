#!/usr/bin/env bash
# live-page-gate.sh — N4 end-to-end witness: obscura drives a live page (read +
# actuate) with NO Chrome and NO CDP. Fail-closed. Never a fabricated green.
#
#   OBSCURA_BIN / UNBROWSE_OBSCURA_BIN  path to the shipped obscura CLI (required)
set -uo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
repo="$(cd "$here/../.." && pwd)"
cd "$repo"

source "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/_resolve-bins.sh"

command -v "$OBS" >/dev/null 2>&1 || [ -x "$OBS" ] || { echo "GATE FAIL: obscura CLI not found (set OBSCURA_BIN)" >&2; exit 1; }
export UNBROWSE_OBSCURA_BIN="$OBS"

# 1. hermetic driver/reader unit tests (framing + arg construction, offline)
echo "== unit: obscura readers + MCP session driver =="
bun test tests/obscura-readers.test.ts tests/obscura-mcp-session.test.ts \
  || { echo "GATE FAIL: driver/reader unit tests red" >&2; exit 1; }

# 2. live: obscura reads AND actuates a real page — assert no NEW Chrome spawned
echo "== live: obscura drives a real page (no Chrome) =="
before="$(pgrep -f 'chrome|chromium' 2>/dev/null | sort || true)"
bun run native/obscura-capture/live-page-witness.ts || { echo "GATE FAIL: live page drive failed" >&2; exit 1; }
after="$(pgrep -f 'chrome|chromium' 2>/dev/null | sort || true)"
newproc="$(comm -13 <(echo "$before") <(echo "$after") | grep -c . || true)"
if [ "${newproc:-0}" -ne 0 ]; then
  echo "GATE FAIL: $newproc new Chrome process(es) spawned — obscura must not launch Chrome" >&2
  comm -13 <(echo "$before") <(echo "$after") >&2
  exit 1
fi
echo "  no new Chrome process spawned"

echo "LIVE-PAGE-GATE PASS: obscura reads + actuates a live page with no Chrome/CDP"
