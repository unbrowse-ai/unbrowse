#!/usr/bin/env bash
# close-stuck-gate.sh — witness for close-stuck-bug: the deadline primitive works
# AND the close path actually wraps its broker-IPC awaits with it, so a wedged
# kuri broker can't hang unbrowse_close.
set -uo pipefail
REPO="$(cd "$(dirname "$0")/../.." && pwd)"; cd "$REPO"
bun test tests/close-deadline.test.ts >/dev/null 2>&1 || { echo "FAIL: deadline primitive test"; exit 1; }
grep -q 'import { withDeadline }' src/api/routes.ts || { echo "FAIL: withDeadline not imported in close path"; exit 1; }
n=$(grep -c 'withDeadline(' src/api/routes.ts)
[ "${n:-0}" -ge 3 ] || { echo "FAIL: expected >=3 withDeadline bounds in close path (har-stop, intercepted, close-tab), got $n"; exit 1; }
echo "ok: close path broker-IPC bounded by withDeadline ($n sites) + primitive tested"
