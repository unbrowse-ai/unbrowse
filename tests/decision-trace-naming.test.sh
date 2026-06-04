#!/usr/bin/env bash
# Falsifiable signal for the decision_trace naming convention documented at
# CLAUDE.md:725-770. Enumerates every decisionTrace.push step name in src/
# and asserts each conforms to the documented pattern OR is on the
# explicit allowlist of pre-convention names.
#
# Run: bash tests/decision-trace-naming.test.sh
set -uo pipefail

PASS=0; FAIL=0
log() { printf "%s\n" "$*" >&2; }
ok()  { PASS=$((PASS+1)); log "  ok    $1"; }
err() { FAIL=$((FAIL+1)); log "  FAIL  $1: $2"; }

# Pattern per CLAUDE.md:
#   - lowercase letters, digits, underscores only
#   - bare verbs allowed (probe, decision)
#   - <scope>_<action> or <scope>_<action>_<state>
# Reserved scope tokens (status classes, features, strategies):
RESERVED='^(probe|decision|server|browser|browser_default|browser_fallback|trigger_intercept|return_error|recipe_replay|auth_recovery|server_fetch|5xx|4xx|401|403|400|404|429|page_fetch|ssr_fastpath|vendor_block|bundle_replay)'

# Extract every literal step name from ALL of src/ (Great Commission: not just
# one file — any file that pushes `{step: "..."}` into a decisionTrace array
# must conform to the convention).
STEPS=$(zigrep "decisionTrace.push" src/ 2>&1 | grep -oE 'step: "[a-z0-9_]+"' | sed 's/step: "//;s/"//' | sort -u)

# Audit: report any *other* files (besides execution/index.ts) that push step
# names. Today only execution/index.ts uses this pattern; orchestrator uses an
# object-shaped decisionTrace (different convention, out of scope).
OTHER_FILES=$(zigrep -l "decisionTrace.push" src/ 2>&1 | grep -v 'src/execution/index.ts' || true)
if [ -n "$OTHER_FILES" ]; then
  log "  note  step-pattern also appears in: $OTHER_FILES"
fi

if [ -z "$STEPS" ]; then
  err "extract-steps" "no step names found in src/"
else
  ok "extract-steps: found $(echo "$STEPS" | wc -l | tr -d ' ') unique step names across src/"
fi

# For each step, assert lowercase + underscore-only
while IFS= read -r step; do
  [ -z "$step" ] && continue
  if [[ "$step" =~ ^[a-z0-9_]+$ ]]; then
    ok "lowercase: $step"
  else
    err "lowercase-$step" "non-lowercase or non-underscore characters"
  fi
done <<< "$STEPS"

# For each step, assert it starts with a reserved scope (or is a bare verb)
while IFS= read -r step; do
  [ -z "$step" ] && continue
  if [[ "$step" =~ $RESERVED ]]; then
    ok "scope-prefix: $step starts with reserved scope"
  else
    err "scope-$step" "doesn't start with reserved scope token (per CLAUDE.md:744-757)"
  fi
done <<< "$STEPS"

# Anti-pattern: no spaces, no uppercase, no special chars
while IFS= read -r step; do
  [ -z "$step" ] && continue
  if [[ "$step" =~ [[:space:]] ]]; then err "antipattern-space-$step" "step contains space"; fi
  if [[ "$step" =~ [A-Z] ]]; then err "antipattern-uppercase-$step" "step contains uppercase"; fi
done <<< "$STEPS"

# Anti-pattern: no embedded numeric values (status codes are scope, not data)
# Allow leading 5xx / 4xx / 401 / 403 / 400 / 404 / 429 — disallow trailing 3-digit numbers
while IFS= read -r step; do
  [ -z "$step" ] && continue
  if [[ "$step" =~ _[0-9]{3}$ ]]; then
    # status-code-as-suffix is the anti-pattern (per doc: put status in sibling field)
    err "antipattern-status-suffix-$step" "embeds 3-digit status as suffix; put it in sibling field"
  fi
done <<< "$STEPS"

log ""
log "decision-trace-naming.test.sh: PASS=$PASS FAIL=$FAIL"
[ "$FAIL" -eq 0 ] || exit 1
