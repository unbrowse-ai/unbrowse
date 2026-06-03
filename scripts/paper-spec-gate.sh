#!/usr/bin/env bash
# paper-spec-gate.sh — falsifiable invariants for the public whitepaper.
#
# Asserts the public corpus stays "to spec" against the published Paper 1
# (arXiv:2604.00694):
#   1. Every frontend-served Paper-1 PDF byte-matches the canonical whitepaper.
#   2. The whitepaper page serves the canonical-named PDF.
#
#   bash scripts/paper-spec-gate.sh        # exit 0 = to spec
set -uo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"; cd "$ROOT"
fail=0
CANON=docs/whitepaper/unbrowse-whitepaper.pdf
md5of(){ md5 -q "$1" 2>/dev/null || md5sum "$1" 2>/dev/null | awk '{print $1}'; }

echo "=== paper-spec-gate ==="

# 1. Served Paper-1 PDFs must byte-match the canonical whitepaper.
[ -f "$CANON" ] || { echo "  FAIL: canonical missing ($CANON)"; fail=1; }
CMD5=$(md5of "$CANON")
for f in frontend/public/papers/internal-apis-are-all-you-need.pdf \
         frontend/public/papers/shadow-apis-are-all-you-need.pdf; do
  if [ ! -f "$f" ]; then echo "  FAIL: missing served PDF $f"; fail=1; continue; fi
  FM5=$(md5of "$f")
  if [ "$FM5" = "$CMD5" ]; then echo "  ok: $(basename "$f") matches canonical (${CMD5:0:8})"
  else echo "  FAIL: $f (${FM5:0:8}) != canonical (${CMD5:0:8})"; fail=1; fi
done

# 4. The whitepaper page must serve the canonical-named PDF, not the stale shadow alias.
PAGE=frontend/src/app/internal-apis-are-all-you-need/page.tsx
if grep -q 'const PAPER_PDF_URL = "/papers/internal-apis-are-all-you-need.pdf"' "$PAGE" 2>/dev/null; then
  echo "  ok: whitepaper page serves /papers/internal-apis-are-all-you-need.pdf"
else echo "  FAIL: whitepaper page PAPER_PDF_URL not the canonical served file ($PAGE)"; fail=1; fi

echo
if [ "$fail" -ne 0 ]; then echo "PAPER-SPEC-GATE FAIL — corpus drifted from the published Paper-1 spec."; exit 1; fi
echo "PAPER-SPEC-GATE PASS — trilogy is to spec; served PDFs canonical."
