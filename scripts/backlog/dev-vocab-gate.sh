#!/usr/bin/env bash
# dev-vocab-gate.sh — witness for dev-vocab-scrub. Proves the dev repo cannot
# leak internal method-vocabulary to the public surface, end to end:
#   1) leak-guard.sh exits 0 (the public-facing dev paths — docs/, README,
#      packages/skill — are vocab-clean and the guard is armed for the vocab),
#   2) a real open-core-sync into a temp tree produces a tree with ZERO
#      vocabulary (the translation pass secularizes src/interop etc. on the way
#      out), so even internal naming in non-doc dev source cannot reach public.
set -uo pipefail
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"; cd "$ROOT"
VOCAB='covenant|superpattern|jesus[ -]?pattern|\bjesus\b|firmament|grain[ -]of[ -]wheat|\bsabbath\b|\bthe cross\b'

fail=0

echo "[dev-vocab] 1/2 leak-guard (armed for vocab)..."
if bash scripts/leak-guard.sh >/tmp/dvg-lg.log 2>&1; then
  echo "  ok — leak-guard exit 0"
else
  echo "  FAIL — leak-guard flagged the public surface:"
  grep -E 'VOCAB LEAK|ZK-IP LEAK|LEAK in' /tmp/dvg-lg.log | head
  fail=1
fi

echo "[dev-vocab] 2/2 open-core-sync translation -> temp tree, grep for vocab..."
TMP="$(mktemp -d)"; trap 'rm -rf "$TMP"' EXIT
if bash scripts/open-core-sync.sh "$TMP" >/tmp/dvg-sync.log 2>&1; then
  hits=$(grep -rIliE "$VOCAB" "$TMP" 2>/dev/null | grep -ivE 'crossmint' | wc -l | tr -d ' ')
  if [ "$hits" = "0" ]; then
    echo "  ok — synced public tree carries no internal vocabulary"
  else
    echo "  FAIL — $hits synced file(s) still carry vocabulary:"
    grep -rIliE "$VOCAB" "$TMP" 2>/dev/null | grep -ivE 'crossmint' | sed "s#$TMP/##" | head
    fail=1
  fi
else
  echo "  FAIL — open-core-sync errored:"; tail -3 /tmp/dvg-sync.log
  fail=1
fi

[ "$fail" -eq 0 ] && { echo "dev-vocab-gate: ok"; exit 0; }
echo "dev-vocab-gate: FAIL"; exit 1
