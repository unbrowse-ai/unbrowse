#!/usr/bin/env bash
# prod-reproducible-gate.sh — the north-star witness for "fix that + make it
# reproducible in prod with the prod CLI (deploy later)".
#
# Exits 0 EXACTLY when all four hold:
#   A. SHIPS  — the scrubbed prod release artifact (built by the same build a release
#      runs, scripts/build-runtime-scrubbed.sh) embeds the REAL energy head (the head's
#      content sha appears in the built cli.js). The published bundle predates the head;
#      this proves the next release ships it.
#   B. SAME   — the head that REPRODUCES in the benchmarks (ebm-runtime-ship-gate, source)
#      is byte-identical to the head that SHIPS (same content sha). So "source reproduces"
#      transfers to "the prod artifact reproduces" — not a different head.
#   C. HONEST — the hard-reasoning 50->92 row is no longer an unaudited raw-base lift; an
#      audit note records its true scope (specialist-taught, trained-baseline) and the
#      paper carries that scope, not an inflated claim.
#   D. LINKED — both new whitepapers are served (PDF in frontend/public) AND listed in the
#      /papers index, like the rest.
#
# The npm publish (v* tag -> CI) is the deferred "deploy later"; this gate proves the
# artifact that publish will ship is correct and reproducible.
set -uo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT"
FAIL=0
HEAD_SRC="src/ranking/signals/route-head.embedded.ts"
SHA="$(grep -oE 'sha:[[:space:]]*"[a-f0-9]+"' "$HEAD_SRC" 2>/dev/null | grep -oE '[a-f0-9]{6,}' | head -1)"

echo "=== A. SHIPS — prod release artifact embeds the real head (sha $SHA) ==="
BUILT_DIR=".tmp-prodcli-runtime"
if bash scripts/build-runtime-scrubbed.sh "$BUILT_DIR" >/tmp/prodbuild.$$.log 2>&1; then
  BUILT="$BUILT_DIR/cli.js"
  if [ -n "$SHA" ] && grep -q "$SHA" "$BUILT" 2>/dev/null; then
    echo "[A] built prod bundle ($(wc -c <"$BUILT" | tr -d ' ') bytes) carries head sha $SHA ✅"
  else
    echo "[A] built prod bundle MISSING head sha $SHA ❌"; FAIL=1
  fi
else
  echo "[A] scrubbed prod build FAILED:"; tail -4 /tmp/prodbuild.$$.log | sed 's/^/    /'; FAIL=1
fi
rm -f /tmp/prodbuild.$$.log

echo "=== B. SAME — the reproducing head is the head that ships ==="
if grep -q 'synthetic: false' "$HEAD_SRC" 2>/dev/null; then
  echo "[B] source head is real (synthetic:false), sha $SHA ✅"
else
  echo "[B] source head is synthetic ❌"; FAIL=1
fi
if bash bench/ebm-runtime-ship-gate.sh >/tmp/ship.$$.log 2>&1; then
  echo "[B] ebm-runtime-ship-gate green — head reproduces (warm>cold>back-off) ✅"
else
  echo "[B] ebm-runtime-ship-gate RED:"; tail -4 /tmp/ship.$$.log | sed 's/^/    /'; FAIL=1
fi
rm -f /tmp/ship.$$.log

echo "=== C. HONEST — hard-reasoning 50->92 row scoped, not an inflated raw-base lift ==="
AUDIT="bench/execute-dont-guess/specialist_baseline_audit.md"
if [ -s "$AUDIT" ] && grep -qiE 'trained .*baseline|specialist.?taught|not a raw[- ]base lift' "$AUDIT"; then
  echo "[C] audit note records the honest scope: $AUDIT ✅"
else
  echo "[C] missing/empty honest-scope audit note ($AUDIT) ❌"; FAIL=1
fi
# the paper must carry the scope caveat, not a bare raw-base 50->92 claim
if grep -qiE 'trained.{0,4}r1 baseline|specialist.{0,6}baseline|unverified|under.?audit' paper/execute-dont-guess.tex 2>/dev/null; then
  echo "[C] paper carries the trained-baseline caveat ✅"
else
  echo "[C] paper presents 50->92 without the trained-baseline caveat ❌"; FAIL=1
fi

echo "=== D. LINKED — both whitepapers served + listed in /papers ==="
for n in execute-dont-guess energy-route-ranking; do
  [ -s "frontend/public/$n.pdf" ] && echo "[D] PDF served: /$n.pdf ✅" || { echo "[D] PDF NOT in frontend/public: $n.pdf ❌"; FAIL=1; }
  grep -q "$n.pdf" frontend/src/app/papers/page.tsx 2>/dev/null && echo "[D] listed in /papers index: $n ✅" || { echo "[D] NOT listed in /papers: $n ❌"; FAIL=1; }
done

echo "================================================"
[ "$FAIL" -eq 0 ] && { echo "[prod-reproducible] PASS — prod artifact ships+reproduces the head; row honest; papers linked"; exit 0; } \
                  || { echo "[prod-reproducible] FAIL"; exit 1; }
