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

# (1) the flagship paper is reflected on BOTH the frontend module AND the canonical index.
#     Only "Internal APIs Are All You Need" is published on unbrowse.ai; the companion
#     papers remain in the canonical index but are withdrawn from the site.
check_paper() { # <frontend-id> <index-grep>
  grep -q "$1" "$fe"  || { echo "  RED  frontend $fe missing paper: $1"; fail=1; }
  grep -qE "$2" "$idx" || { echo "  RED  index $idx missing paper: $2"; fail=1; }
}
check_paper "internal-apis-are-all-you-need" "internal-apis-are-all-you-need"
[ "$fail" -eq 0 ] && echo "  ok   frontend reflects the flagship paper (papers.ts ↔ paper index)"

# (2) every PDF the frontend still advertises resolves to a real file under frontend/public/.
#     The flagship's on-site form is an internal Next.js page, not a PDF, so this loop
#     is a no-op unless a PDF href is re-introduced — kept as a standing invariant.
for pdf in $(grep -oE 'href: "/[a-z0-9-]+\.pdf"' "$fe" | sed -E 's#.*/([a-z0-9-]+)\.pdf.*#\1#'); do
  [ -f "frontend/public/$pdf.pdf" ] && echo "  ok   PDF present: frontend/public/$pdf.pdf" \
    || { echo "  RED  $fe advertises $pdf.pdf but frontend/public/$pdf.pdf is missing"; fail=1; }
done

# (3) the /contract story is surfaced on the frontend (contract-native explainer).
[ -f "$organ" ] && echo "  ok   /contract surfaced on frontend (contract-organ explainer)" \
  || { echo "  RED  no frontend /contract explainer ($organ)"; fail=1; }

echo
[ "$fail" -eq 0 ] && { echo "CONTRACT-CHAIN-FRONTEND GREEN."; exit 0; } || { echo "CONTRACT-CHAIN-FRONTEND RED."; exit 1; }
