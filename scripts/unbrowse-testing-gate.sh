#!/usr/bin/env bash
# unbrowse-testing-gate.sh — jesus-ralph witness for "resolve all of gitea
# Unbrowse/unbrowse-testing (U-2…U-14) and retest".
#
# Exit 0 ONLY when:
#   G1 count — tests/unbrowse-testing.test.ts holds >= 10 `it(` repros (one per open
#              issue) — the count-guard stops an empty/partial file false-greening.
#   G2 green — `bun test tests/unbrowse-testing.test.ts` exits 0 (every repro passes).
set -uo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"; cd "$ROOT" || exit 2
fail() { echo "GATE RED — $1"; exit 1; }
shopt -s nullglob
FILES=(tests/unbrowse-testing*.test.ts)
[ "${#FILES[@]}" -ge 1 ] || fail "G1 coverage: no tests/unbrowse-testing*.test.ts files"
# G1 coverage — EACH open issue id (U-2..U-14) must have a named repro. A bare count
# is gameable (extra tests in one cluster mask a missing cluster), so require by name.
ISSUES="2 3 4 6 7 8 9 12 13 14"
miss=""
for n in $ISSUES; do
  grep -rqhE "U-$n\b" "${FILES[@]}" 2>/dev/null || miss="$miss U-$n"
done
[ -z "$miss" ] || fail "G1 coverage: missing repro(s) for$miss"
echo "ok G1 coverage — all 10 issue repros present (U-$ISSUES)"
bun test "${FILES[@]}" >/tmp/ubt-gate.log 2>&1 || { tail -25 /tmp/ubt-gate.log; fail "G2 green: a repro is still RED (unfixed issue)"; }
echo "ok G2 green — every issue repro passes"
echo "GATE GREEN — all unbrowse-testing issues resolved + retested"
