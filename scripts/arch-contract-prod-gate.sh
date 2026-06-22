#!/usr/bin/env bash
# arch-contract-prod-gate.sh — witness for the north star: "100 unbrowse-related levers +
# deployed to prod via /contract-deploy SIGNED + paper/ unified." Binding witnessable legs:
#   A. levers-gate green       — >=100 genuine unbrowse-related shipped levers
#   C. /contract-deploy LIVE   — verified deploy marker present
#   D. SIGNED (live)           — `contract verify-self` exits 0
#   E. paper/ unified          — paper-unify-gate green (one index + consistent gated corpus)
#   F. source-of-truth bound   — contract-chain-gate green (papers→code→cli→frontend, /taste)
# NOT gated: "entire arch is /contract-shaped" — aspirational, only partly true. No fake green.
set -uo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"; cd "$ROOT"
fail=0
bash scripts/levers-gate.sh >/dev/null 2>&1 && echo "  ok   A: 100+ unbrowse-related levers" || { echo "  RED  A: levers-gate"; fail=1; }
[ -f .claude/contract-deploy-verified.marker ] && echo "  ok   C: /contract-deploy LIVE" || { echo "  RED  C: contract-deploy not verified"; fail=1; }
"$HOME/.claude/skills/contract/scripts/contract" verify-self >/dev/null 2>&1 && echo "  ok   D: SIGNED (verify-self OK)" || { echo "  RED  D: not signed/valid"; fail=1; }
bash scripts/paper-unify-gate.sh >/dev/null 2>&1 && echo "  ok   E: paper/ unified (index + gates)" || { echo "  RED  E: paper-unify-gate"; fail=1; }
bash scripts/contract-chain-gate.sh >/dev/null 2>&1 && echo "  ok   F: source-of-truth bound (papers→code→cli→frontend, /taste)" || { echo "  RED  F: contract-chain-gate"; fail=1; }
echo
[ "$fail" -eq 0 ] && { echo "ARCH-CONTRACT-PROD-GATE GREEN."; exit 0; } || { echo "ARCH-CONTRACT-PROD-GATE RED."; exit 1; }
