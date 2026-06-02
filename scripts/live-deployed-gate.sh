#!/usr/bin/env bash
# live-deployed-gate.sh — the right things are LIVE and reflect what they are.
#
# Exits 0 exactly when:
#   1. SOURCE  — scripts/web-reflects-gate.sh green (open-core truth in the code,
#      visibility boundary correct + declared, papers done).
#   2. LIVE UP — https://www.unbrowse.ai responds 200.
#   3. LIVE ADAPTERS — the deployed /docs/adapters page serves the drop-in catalogue.
#   4. LIVE TRUTH — the deployed site carries no stale "AGPL" license claim.
#
# Checks 2-4 only pass once the frontend is actually deployed, so this gate is the
# runnable witness for "frontend web private but deployed + reflects properly".
set -uo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"
SITE="https://www.unbrowse.ai"
fail=0
section() { echo; echo "=== $1 ==="; }

section "1. source reflects the open-core truth"
if bash scripts/web-reflects-gate.sh >/tmp/ldg_src.out 2>&1; then echo "  web-reflects-gate: green"; else echo "  SOURCE-FAIL (see /tmp/ldg_src.out)"; fail=1; fi

section "2. site is live"
code=$(curl -s -o /dev/null -w '%{http_code}' --max-time 20 "$SITE" || echo 000)
if [ "$code" = "200" ]; then echo "  live: $SITE -> 200"; else echo "  LIVE-FAIL: $SITE -> $code"; fail=1; fi

section "3. /docs/adapters is live with the drop-in catalogue"
body=$(curl -s --max-time 20 "$SITE/docs/adapters" || true)
if printf '%s' "$body" | grep -qi 'drop-in' && printf '%s' "$body" | grep -qiE '@unbrowse/|unbrowse-requests'; then
  echo "  live: /docs/adapters serves the adapter catalogue"
else echo "  ADAPTERS-LIVE-FAIL: /docs/adapters did not serve the catalogue"; fail=1; fi

section "4. live site carries no stale AGPL claim"
home=$(curl -s --max-time 20 "$SITE" || true)
if printf '%s' "$home" | grep -qi 'AGPL'; then echo "  TRUTH-LIVE-FAIL: live homepage still says AGPL"; fail=1; else echo "  live: no AGPL on the homepage"; fi

echo
if [ "$fail" -ne 0 ]; then echo "LIVE-DEPLOYED-GATE FAIL — not yet live + reflecting properly."; exit 1; fi
echo "LIVE-DEPLOYED-GATE PASS — the site is deployed live and reflects the true open-core boundary."
