#!/usr/bin/env bash
# deploy-papers-gate.sh — the north-star witness for "deploy it + write whitepapers".
# Exits 0 EXACTLY when both halves are real:
#
#   A. DEPLOYED — the live production benchmarks page serves the honest code-correctness
#      number (68% baseline) and NOT the inflated one (25% as the code baseline).
#   B. PAPERS  — the new .tex whitepapers each (1) exist, (2) pass the paper gate
#      (reflect code via anchors.tsv + no moat leak), and (3) carry none of the
#      internal working vocabulary (plain academic language, secular face outward).
#
# No half can be faked: A curls the real CDN; B runs the real paper-gate + a vocab grep.
set -uo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"
FAIL=0

PAPERS=(
  paper/execute-dont-guess.tex
  paper/energy-route-ranking.tex
)
# Internal working vocabulary that must NEVER cross into a public artifact.
FORBIDDEN='jespa|jesus|covenant|scripture|god[- ]particle|grain[- ]of[- ]wheat|firmament|breath-eval-build|superpattern|the cross primitive|genesis-day'

echo "=== B. PAPERS (exist + reflect code + no leak + no internal vocab) ==="
for p in "${PAPERS[@]}"; do
  if [ ! -s "$p" ]; then echo "[papers] MISSING: $p"; FAIL=1; continue; fi
  if bash scripts/paper-gate.sh "$p" >/tmp/pg.$$.log 2>&1; then
    echo "[papers] paper-gate PASS: $p"
  else
    echo "[papers] paper-gate FAIL: $p"; tail -6 /tmp/pg.$$.log | sed 's/^/    /'; FAIL=1
  fi
  if grep -iEn "$FORBIDDEN" "$p" >/tmp/vocab.$$.log 2>&1; then
    echo "[papers] INTERNAL VOCAB LEAK in $p:"; sed 's/^/    /' /tmp/vocab.$$.log; FAIL=1
  else
    echo "[papers] vocab-clean: $p"
  fi
done
rm -f /tmp/pg.$$.log /tmp/vocab.$$.log

echo "=== A. DEPLOYED (live page serves honest 68%, not inflated 25% baseline) ==="
URL="${DEPLOY_URL:-https://www.unbrowse.ai/docs/benchmarks}"
BODY="$(curl -fsSL --max-time 25 "$URL" 2>/dev/null || true)"
if [ -z "$BODY" ]; then
  echo "[deploy] could not fetch $URL (not deployed / network)"; FAIL=1
else
  # honest signal present, inflated code-baseline absent
  if printf '%s' "$BODY" | grep -q '68%'; then
    echo "[deploy] live page serves honest 68% baseline ✅"
  else
    echo "[deploy] live page MISSING honest 68% — stale deploy"; FAIL=1
  fi
  # the inflated pairing "25%" -> "100%" code-correctness must be gone from the live page
  if printf '%s' "$BODY" | grep -qE '25%.*code|code.*25%'; then
    echo "[deploy] live page STILL shows inflated 25% code baseline ❌"; FAIL=1
  else
    echo "[deploy] no inflated 25% code baseline on live page ✅"
  fi
fi

echo "================================================"
[ "$FAIL" -eq 0 ] && { echo "[deploy-papers] PASS — deployed + papers gate-clean"; exit 0; } \
                  || { echo "[deploy-papers] FAIL"; exit 1; }
