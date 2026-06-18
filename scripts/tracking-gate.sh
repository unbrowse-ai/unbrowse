#!/usr/bin/env bash
# tracking-gate.sh — the SEAL for the tracking north star (docs/plans/tracking-*.md).
# Exits 0 only when all four nodes are green on a fresh run. No cached green; each
# check runs its real witness. Run twice for the two-witness rule (Gen 2:2).
set -uo pipefail
cd "$(dirname "$0")/.." || exit 2
fail=0
ok(){ printf 'ok   %s\n' "$1"; }
bad(){ printf 'FAIL %s\n' "$1"; fail=1; }

# G4 — local impact-log ⇄ backend session reconcile (savings agree at the source)
bun test tests/impact-reconcile.test.ts >/dev/null 2>&1 && ok "G4 reconcile (impact ↔ analytics-session)" || bad "G4 reconcile test"

# G3 — per-route contributions aggregation (backend)
( cd backend && bun test tests/contributions-ledger.test.ts >/dev/null 2>&1 ) \
  && ok "G3 contributions aggregation" || bad "G3 contributions test"

# G1 — CLI `eval stats --json` emits the four `you` quantities (non-null, local-first)
you_ok=$(timeout 90 bun src/cli.ts eval stats --json 2>/dev/null | python3 -c "
import sys,json
try:
  y=json.load(sys.stdin).get('you',{})
  print('1' if all(y.get(k) is not None for k in ['cost_saved_usd','time_saved_hours','contributions','payouts_usd']) else '0')
except Exception: print('0')
" 2>/dev/null)
[ "$you_ok" = "1" ] && ok "G1 CLI eval stats you-view (4 fields non-null)" || bad "G1 CLI you-view"

# G2 — FE network 'everyone' view + G3 FE panel present, and the on-system gate green
grep -q "NetworkImpact" frontend/src/components/contributor-dashboard.tsx \
  && grep -q "ContributionsLedger" frontend/src/components/contributor-dashboard.tsx \
  && ok "G2/G3 FE panels present" || bad "FE panels missing"
( cd frontend && bash scripts/hallmark-gate.sh >/dev/null 2>&1 ) \
  && ok "FE on-system gate (hallmark) GREEN" || bad "FE on-system gate RED"

if [ "$fail" -eq 0 ]; then echo "SEAL GREEN — tracking north star settled (you + everyone, CLI + FE)"; exit 0; fi
echo "SEAL RED"; exit 1
