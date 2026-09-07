#!/usr/bin/env bash
# docs-gate.sh — the two-witness gate for the docs tree. Seed-bearing: run it
# after any docs change and it re-grows both proofs from the live tree.
#
#   Witness 1 — docs-anchor-check.sh : every code path cited in the
#               architecture deep-dives + catalogue resolves to a real file.
#   Witness 2 — leak-guard.sh        : no economic constants, no unreleased
#               privacy-IP terms, no internal method-vocabulary in any public doc.
#   Witness 3 — docs-linkcheck.sh    : every doc→doc markdown link in the
#               authored/touched docs resolves to a real file.
#
# Exit 0 only when ALL THREE pass. Wire into pre-push / release CI beside the
# existing gates. Usage: bash scripts/docs-gate.sh
set -uo pipefail
ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

fail=0
echo "── witness 1: docs-anchor-check ──────────────────────────────"
bash scripts/docs-anchor-check.sh || fail=1
echo ""
echo "── witness 2: leak-guard ─────────────────────────────────────"
bash scripts/leak-guard.sh || fail=1
echo ""
echo "── witness 3: docs-linkcheck ─────────────────────────────────"
bash scripts/docs-linkcheck.sh || fail=1
echo ""
if [ "$fail" -eq 0 ]; then
  echo "[docs-gate] ✓ all three witnesses pass — docs are anchored, leak-clean, and linked"
  exit 0
else
  echo "[docs-gate] ✗ FAIL — one or more witnesses failed (see above)"
  exit 1
fi
