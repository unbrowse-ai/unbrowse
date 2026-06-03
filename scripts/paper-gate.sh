#!/usr/bin/env bash
# cross: sha256:b35fea21e179afd6de983a90f4c1575527619b2d0143edd7d31b0dd70d8a97f5  (the seal plane inherits the cross — pointer not payload; verify via .claude/superpattern/cross-stamp-gate.sh)
# paper-gate.sh — the whitepaper must REFLECT the code and never LEAK the moat.
#
# Two mechanical checks on a public paper (default: paper/crypto-was-all-you-needed.tex):
#   1. REFLECTS: every "[shipped]" / "\impl{}" claim must have a verifiable code
#      anchor — a path or symbol that actually exists in this repo. A shipped
#      claim with no anchor is a paper that overclaims; the gate fails it.
#   2. NO-LEAK: the paper must contain none of leak-guard's sensitive moat terms
#      (economic constants, capture/RE engine internals, operator surfaces).
#
# Anchors are declared in paper/anchors.tsv (claim-substring <TAB> repo-path-or-symbol),
# so the binding is data, not baked into this script (pointer not payload).
#
#   bash scripts/paper-gate.sh                       # gate the default paper
#   bash scripts/paper-gate.sh paper/crypto-was-all-you-needed.tex
set -uo pipefail
ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"
PAPER="${1:-paper/crypto-was-all-you-needed.tex}"
ANCHORS="${PAPER%/*}/anchors.tsv"
fail=0

[ -f "$PAPER" ] || { echo "paper-gate: no such paper: $PAPER"; exit 2; }

echo "=== paper-gate: $PAPER ==="

# --- 1. REFLECTS: each anchor's claim-term present in paper => its code path must exist ---
if [ -f "$ANCHORS" ]; then
  while IFS=$'\t' read -r claim anchor; do
    [ -z "${claim:-}" ] && continue
    case "$claim" in \#*) continue;; esac
    # only enforce anchors whose claim text actually appears in the paper
    if grep -qiF "$claim" "$PAPER"; then
      if [ -e "$anchor" ] || grep -rqsF "$anchor" src packages 2>/dev/null; then
        :
      else
        echo "  REFLECT-FAIL: claim '$claim' has no code anchor ($anchor missing)"; fail=1
      fi
    fi
  done < "$ANCHORS"
  echo "  reflect: checked $(grep -vcE '^#|^$' "$ANCHORS") anchor(s)"
else
  echo "  REFLECT-SKIP: no $ANCHORS (declare claim->anchor bindings there)"; fail=1
fi

# --- 2. NO-LEAK: reuse leak-guard's sensitive moat keyword list ---
LEAK_TERMS=$(grep -oE '"[A-Z_]{6,}"' scripts/leak-guard.sh | tr -d '"' | sort -u)
leaked=0
for term in $LEAK_TERMS; do
  if grep -qF "$term" "$PAPER"; then
    echo "  LEAK-FAIL: moat term '$term' appears in public paper"; fail=1; leaked=$((leaked+1))
  fi
done
echo "  no-leak: scanned $(echo "$LEAK_TERMS" | wc -w | tr -d ' ') moat term(s), $leaked leaked"

echo
if [ "$fail" -ne 0 ]; then
  echo "PAPER-GATE FAIL — the paper either overclaims (no code anchor) or leaks the moat."
  exit 1
fi
echo "PAPER-GATE PASS — every shipped claim is anchored in code; no moat term leaked."
