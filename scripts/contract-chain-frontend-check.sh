#!/usr/bin/env bash
# contract-chain-frontend-check.sh — the cli→frontend reflection witness (the chain's leaf leg).
# The frontend BINDS to the same source of truth when (1) its single-source papers module
# (frontend/src/lib/papers.ts) reflects the trilogy the canonical paper index carries, (2) every
# PDF it advertises actually exists under frontend/public/, and (3) the /contract story itself is
# surfaced (the contract-organ explainer). Falsifiable: drop a paper from the frontend, or a PDF,
# or the explainer, and this reddens.
set -uo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"; cd "$ROOT"
fail=0
fe="frontend/src/lib/papers.ts"
idx="paper/README.md"
organ="frontend/src/app/blog/contract-organ-explained/page.tsx"

[ -f "$fe" ]  || { echo "  RED  no $fe (frontend papers single-source)"; exit 1; }
[ -f "$idx" ] || { echo "  RED  no $idx (canonical paper index)"; exit 1; }

# (1) the trilogy is reflected on BOTH the frontend module AND the canonical index.
#     maintenance-network is the same paper as the index's filename "internal-apis-were-not-...".
check_paper() { # <frontend-id> <index-grep>
  grep -q "$1" "$fe"  || { echo "  RED  frontend $fe missing paper: $1"; fail=1; }
  grep -qE "$2" "$idx" || { echo "  RED  index $idx missing paper: $2"; fail=1; }
}
check_paper "internal-apis-are-all-you-need" "internal-apis-are-all-you-need"
check_paper "crypto-was-all-you-needed"      "crypto-was-all-you-needed"
check_paper "unbrowse-maintenance-network"   "internal-apis-were-not-all-you-needed|Unbrowse Maintenance Network"
[ "$fail" -eq 0 ] && echo "  ok   frontend reflects the canonical trilogy (papers.ts ↔ paper index)"

# (2) every advertised PDF resolves to a real file under frontend/public/.
for pdf in crypto-was-all-you-needed unbrowse-maintenance-network; do
  if grep -q "$pdf.pdf" "$fe"; then
    [ -f "frontend/public/$pdf.pdf" ] && echo "  ok   PDF present: frontend/public/$pdf.pdf" \
      || { echo "  RED  $fe advertises $pdf.pdf but frontend/public/$pdf.pdf is missing"; fail=1; }
  fi
done

# (3) the /contract story is surfaced on the frontend (contract-native explainer).
[ -f "$organ" ] && echo "  ok   /contract surfaced on frontend (contract-organ explainer)" \
  || { echo "  RED  no frontend /contract explainer ($organ)"; fail=1; }

echo
[ "$fail" -eq 0 ] && { echo "CONTRACT-CHAIN-FRONTEND GREEN."; exit 0; } || { echo "CONTRACT-CHAIN-FRONTEND RED."; exit 1; }
