#!/usr/bin/env bash
# client-boundary-gate — make the open/private boundary of the public client EXPLICIT
# and regression-proof. Exit 0 only when:
#
#   1. COVERAGE   — every top-level public-client module (src/*/) is classified in
#                   docs/CLIENT-BOUNDARY.tsv. A new, unclassified module fails the gate
#                   (no moat logic slips into the public bundle unreviewed).
#   2. TRACKING   — every module classified migrating / moat-server / review has a row in
#                   docs/CLIENT-BOUNDARY.debt.tsv (no UNTRACKED moat exposure).
#   3. INTEGRITY  — the debt ledger references only real, classified modules.
#
# This does NOT require the (large, gated) server-move to be finished — it makes the
# current exposure visible, counted, and impossible to grow silently. Finishing the
# migration flips debt rows to resolved; the gate stays green throughout.

set -uo pipefail
cd "$(dirname "$0")/.." || exit 2

# Dev-only path (NOT docs/ — the moat-exposure map must not sync to the public repo).
TSV="scripts/boundary/CLIENT-BOUNDARY.tsv"
DEBT="scripts/boundary/CLIENT-BOUNDARY.debt.tsv"
fail=0
pass() { printf '  \033[32m✓\033[0m %s\n' "$1"; }
bad()  { printf '  \033[31m✗\033[0m %s\n' "$1"; fail=1; }

[ -f "$TSV" ]  || { echo "missing $TSV";  exit 1; }
[ -f "$DEBT" ] || { echo "missing $DEBT"; exit 1; }

echo "── client-boundary gate ─────────────────────────────────"

# Parse classified modules: "module<TAB>class<TAB>evidence", skip comments/blanks.
# shellcheck disable=SC2002
classified_modules="$(grep -vE '^\s*#|^\s*$' "$TSV" | awk -F '\t' '{print $1}' | sort -u)"
moat_modules="$(grep -vE '^\s*#|^\s*$' "$TSV" | awk -F '\t' '$2=="moat-server"||$2=="migrating"||$2=="review"{print $1}' | sort -u)"
debt_modules="$(grep -vE '^\s*#|^\s*$' "$DEBT" | awk -F '\t' '{print $1}' | sort -u)"

# Actual public-client module universe = src/*/ directories.
actual_modules="$(for d in src/*/; do basename "$d"; done | sort -u)"

# 1. COVERAGE — every actual module is classified.
missing_cov=0
while IFS= read -r m; do
  [ -z "$m" ] && continue
  if ! grep -qxF "$m" <<<"$classified_modules"; then
    bad "UNCLASSIFIED public module: src/$m/ — add a row to $TSV"
    missing_cov=$((missing_cov+1))
  fi
done <<<"$actual_modules"
[ "$missing_cov" -eq 0 ] && pass "coverage: all $(wc -l <<<"$actual_modules" | tr -d ' ') public src/ modules classified"

# 1b. STALE — classified module that no longer exists (keeps the manifest honest).
while IFS= read -r m; do
  [ -z "$m" ] && continue
  if ! grep -qxF "$m" <<<"$actual_modules"; then
    bad "STALE manifest row: '$m' is in $TSV but src/$m/ does not exist"
  fi
done <<<"$classified_modules"

# 2. TRACKING — every moat/migrating/review module has a debt row.
untracked=0
while IFS= read -r m; do
  [ -z "$m" ] && continue
  if ! grep -qxF "$m" <<<"$debt_modules"; then
    bad "UNTRACKED moat exposure: '$m' is moat-server/migrating/review but missing from $DEBT"
    untracked=$((untracked+1))
  fi
done <<<"$moat_modules"
[ "$untracked" -eq 0 ] && pass "tracking: every moat/migrating/review module has a debt row ($(wc -l <<<"$moat_modules" | tr -d ' ') tracked)"

# 3. INTEGRITY — debt rows reference real, classified modules.
while IFS= read -r m; do
  [ -z "$m" ] && continue
  if ! grep -qxF "$m" <<<"$classified_modules"; then
    bad "PHANTOM debt row: '$m' in $DEBT is not classified in $TSV"
  fi
done <<<"$debt_modules"

# Report the live exposure count (informational — not a failure by itself).
exposed="$(grep -vE '^\s*#|^\s*$' "$DEBT" | awk -F '\t' '$5=="exposed"||$5=="migrating"||$5=="review-pending"{c++} END{print c+0}')"
echo "─────────────────────────────────────────────────────────"
echo "exposure ledger: ${exposed} module(s) tracked as not-yet-client-local (see $DEBT)"

if [ "$fail" -ne 0 ]; then
  echo "GATE FAIL — boundary not fully classified/tracked"
  exit 1
fi
echo "GATE PASS — boundary explicit + every moat module tracked (exposure visible, regression-proof)"
exit 0
