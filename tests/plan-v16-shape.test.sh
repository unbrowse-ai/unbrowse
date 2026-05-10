#!/usr/bin/env bash
# Falsifier: pins the structural shape of plan-v16.md (Track-A-only revision).
# Prevents regression to Track B / marketplace splits / stash recovery references.
set -u
PLAN="$(cd "$(dirname "$0")/.." && pwd)/plan-v16.md"
PASS=0; FAIL=0
ok()   { echo "PASS: $1"; PASS=$((PASS+1)); }
bad()  { echo "FAIL: $1 — $2"; FAIL=$((FAIL+1)); }
have() { grep -q -- "$1" "$PLAN"; }
ihave(){ grep -qi -- "$1" "$PLAN"; }

# 1. exists + non-empty + has substantive structure (Step 8 audit: bare -s is tautological)
if [ -s "$PLAN" ] && [ "$(wc -l < "$PLAN")" -gt 20 ]; then ok "plan-v16.md exists with >20 lines"
else bad "plan-v16.md exists with >20 lines" "missing, empty, or 1-line stub: $PLAN"; fi

# 2. Track A
if have "Track A"; then ok "mentions 'Track A'"
else bad "mentions 'Track A'" "string not found"; fi

# 3. branch name
if have "feat/agent-ux-run-planner"; then ok "mentions branch feat/agent-ux-run-planner"
else bad "mentions branch feat/agent-ux-run-planner" "string not found"; fi

# 4. seeds commit
if have "99c4cd30"; then ok "mentions seeds commit 99c4cd30"
else bad "mentions seeds commit 99c4cd30" "string not found"; fi

# 5. A1 and A2 tiers
if have "Tier A1"; then ok "mentions Tier A1 header"
else bad "mentions Tier A1 header" "string 'Tier A1' not found"; fi
if have "Tier A2"; then ok "mentions Tier A2 header"
else bad "mentions Tier A2 header" "string 'Tier A2' not found"; fi

# 6. Pre-conditions header
if grep -qE '^#+.*Pre-conditions' "$PLAN"; then ok "section header 'Pre-conditions' present"
else bad "section header 'Pre-conditions' present" "no markdown header matched"; fi

# 7. Definition of done header
if grep -qE '^#+.*Definition of done' "$PLAN"; then ok "section header 'Definition of done' present"
else bad "section header 'Definition of done' present" "no markdown header matched"; fi

# 8. NEGATIVE: Track B
if ihave "Track B"; then bad "must NOT mention 'Track B'" "regression: Track B reference found"
else ok "no 'Track B' reference"; fi

# 9. NEGATIVE: marketplace splits / fee splits
if ihave "marketplace splits" || ihave "fee splits"; then
  bad "must NOT mention 'marketplace splits' or 'fee splits'" "regression: splits language found"
else ok "no marketplace/fee splits language"; fi

# 10. NEGATIVE: domain-vault / payments-ledger / splits-policy
if ihave "domain-vault" || ihave "payments-ledger" || ihave "splits-policy"; then
  bad "must NOT mention domain-vault/payments-ledger/splits-policy" "regression: Track B file refs found"
else ok "no Track B file references"; fi

# 11. NEGATIVE: stash@{
if grep -q 'stash@{' "$PLAN"; then bad "must NOT reference 'stash@{'" "regression: stash recovery reference found"
else ok "no stash@{ reference"; fi

TOTAL=$((PASS+FAIL))
if [ $FAIL -eq 0 ]; then
  echo "11/11"
  exit 0
else
  echo "${FAIL}/11 FAIL"
  exit 1
fi
