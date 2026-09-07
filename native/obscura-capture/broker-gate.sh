#!/usr/bin/env bash
# broker-gate.sh — witness the obscura SESSION BROKER: a page session persists
# across independent CLI calls (obscura mcp --http), with NO Chrome. Fail-closed.
#
#   OBSCURA_BIN / UNBROWSE_OBSCURA_BIN  path to the shipped obscura CLI (required)
set -uo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
repo="$(cd "$here/../.." && pwd)"
cd "$repo"

source "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/_resolve-bins.sh"

command -v "$OBS" >/dev/null 2>&1 || [ -x "$OBS" ] || { echo "GATE FAIL: obscura CLI not found (set OBSCURA_BIN)" >&2; exit 1; }
export UNBROWSE_OBSCURA_BIN="$OBS"

echo "== unit: session broker (framing, records, helpers) =="
bun test tests/obscura-session-broker.test.ts || { echo "GATE FAIL: broker unit tests red" >&2; exit 1; }

echo "== live: page session persists across independent attaches (no Chrome) =="
before="$(pgrep -f 'chrome|chromium' 2>/dev/null | sort || true)"
bun run native/obscura-capture/broker-witness.ts || { echo "GATE FAIL: broker live witness failed" >&2; exit 1; }
after="$(pgrep -f 'chrome|chromium' 2>/dev/null | sort || true)"
newproc="$(comm -13 <(echo "$before") <(echo "$after") | grep -c . || true)"
if [ "${newproc:-0}" -ne 0 ]; then
  echo "GATE FAIL: $newproc new Chrome process(es) spawned" >&2
  comm -13 <(echo "$before") <(echo "$after") >&2
  exit 1
fi
echo "  no new Chrome process spawned"

echo "BROKER-GATE PASS: obscura session broker persists a page across CLI calls, no Chrome"
