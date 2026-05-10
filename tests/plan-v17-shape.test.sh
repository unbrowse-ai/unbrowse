#!/usr/bin/env bash
# Falsifier: pins the structural shape of plan-v17.md (Tier 1/Tier 2 Akamai+Kasada).
# Catches regressions to Track B, marketplace splits, stash refs, or unqualified solver claims.
set -u
PLAN="$(cd "$(dirname "$0")/.." && pwd)/plan-v17.md"
PASS=0; FAIL=0
ok()   { echo "PASS: $1"; PASS=$((PASS+1)); }
bad()  { echo "FAIL: $1 — $2"; FAIL=$((FAIL+1)); }
have() { grep -q -- "$1" "$PLAN"; }
ihave(){ grep -qi -- "$1" "$PLAN"; }
count(){ grep -o -- "$1" "$PLAN" | wc -l | tr -d ' '; }

# 1. exists + >20 lines
if [ -s "$PLAN" ] && [ "$(wc -l < "$PLAN")" -gt 20 ]; then ok "plan-v17.md exists with >20 lines"
else bad "plan-v17.md exists with >20 lines" "missing, empty, or stub: $PLAN"; fi

# 2. Tier 1 + Tier 2 headers
if grep -qE '^## Tier 1' "$PLAN"; then ok "## Tier 1 header present"
else bad "## Tier 1 header present" "no '## Tier 1' header"; fi
if grep -qE '^## Tier 2' "$PLAN"; then ok "## Tier 2 header present"
else bad "## Tier 2 header present" "no '## Tier 2' header"; fi

# 3. Akamai >=3 mentions
N=$(count "Akamai")
if [ "$N" -ge 3 ]; then ok "Akamai mentioned ${N} times (>=3)"
else bad "Akamai mentioned >=3 times" "only ${N} occurrence(s)"; fi

# 4. Kasada >=3 mentions
N=$(count "Kasada")
if [ "$N" -ge 3 ]; then ok "Kasada mentioned ${N} times (>=3)"
else bad "Kasada mentioned >=3 times" "only ${N} occurrence(s)"; fi

# 5. branch
if have "feat/agent-ux-run-planner"; then ok "mentions branch feat/agent-ux-run-planner"
else bad "mentions branch feat/agent-ux-run-planner" "string not found"; fi

# 6. cf-challenge.ts + px-challenge.ts templates
if have "cf-challenge.ts"; then ok "mentions cf-challenge.ts template"
else bad "mentions cf-challenge.ts" "string not found"; fi
if have "px-challenge.ts"; then ok "mentions px-challenge.ts template"
else bad "mentions px-challenge.ts" "string not found"; fi

# 7. Definition of done
if grep -qE '^#+.*Definition of done' "$PLAN"; then ok "section 'Definition of done' present"
else bad "section 'Definition of done' present" "no markdown header matched"; fi

# 8. Risk register
if grep -qE '^#+.*Risk register' "$PLAN"; then ok "section 'Risk register' present"
else bad "section 'Risk register' present" "no markdown header matched"; fi

# 9. Pre-conditions
if grep -qE '^#+.*Pre-conditions' "$PLAN"; then ok "section 'Pre-conditions' present"
else bad "section 'Pre-conditions' present" "no markdown header matched"; fi

# 10. specific bench hostnames
if ihave "nike" || ihave "canadagoose" || ihave "decathlon"; then ok "mentions specific bench hostname"
else bad "mentions specific bench hostname" "no nike/canadagoose/decathlon"; fi

# 11. NEGATIVE: Track B
if ihave "Track B"; then bad "must NOT mention 'Track B'" "regression: Track B reference"
else ok "no 'Track B' reference"; fi

# 12. NEGATIVE: splits language outside the "does NOT do" disclaimer block
SCOPED=$(awk '/^## What this plan does NOT do/{skip=1;next} /^## /&&skip{skip=0} !skip{print}' "$PLAN")
if echo "$SCOPED" | grep -qiE 'marketplace splits|fee splits'; then
  bad "must NOT mention splits language" "regression outside disclaimer"
else ok "no marketplace/fee splits language outside disclaimer"; fi

# 13. NEGATIVE: stash@{
if grep -q 'stash@{' "$PLAN"; then bad "must NOT reference 'stash@{'" "regression: stash ref"
else ok "no stash@{ reference"; fi

# 14. NEGATIVE: unqualified 'production-ready' / 'guaranteed' for solver
if grep -niE 'solver.*(production-ready|guaranteed)|(production-ready|guaranteed).*solver' "$PLAN" \
    | grep -viE '(not |never |cannot |may |might |aspirational|goal|target|without|isn.t|is not)' \
    | grep -q .; then
  bad "must NOT claim solver production-ready/guaranteed unqualified" "unqualified claim found"
else ok "no unqualified solver production-ready/guaranteed claim"; fi

# 15-17. Step 8 audit: pin Tier 4 + akamai_bot_manager + Step-finding markers
if grep -qE '^## Tier 4' "$PLAN"; then PASS=$((PASS+1)); echo "PASS: ## Tier 4 header present"
else FAIL=$((FAIL+1)); echo "FAIL: ## Tier 4 header missing"; fi
if grep -q 'akamai_bot_manager' "$PLAN"; then PASS=$((PASS+1)); echo "PASS: mentions akamai_bot_manager exact string"
else FAIL=$((FAIL+1)); echo "FAIL: missing akamai_bot_manager exact string"; fi
if grep -qE 'Step [568] (finding|audit)' "$PLAN"; then PASS=$((PASS+1)); echo "PASS: integrity marker (Step N finding/audit) present"
else FAIL=$((FAIL+1)); echo "FAIL: missing Step-N audit-trail markers"; fi
TOTAL=$((PASS+FAIL))
if [ $FAIL -eq 0 ]; then
  echo "${PASS}/${TOTAL}"
  exit 0
else
  echo "${FAIL}/${TOTAL} FAIL (passed ${PASS})"
  exit 1
fi
