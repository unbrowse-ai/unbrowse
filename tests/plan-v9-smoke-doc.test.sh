#!/usr/bin/env bash
# Falsifier for plan-v9 BCDE smoke-results doc append.
# The deliverable for plan-v9 BCDE was a documented smoke-test verdict
# (no code, by design). This test asserts the doc carries the required
# structural elements so a future edit can't silently delete the verdict.
#
# Run: bash tests/plan-v9-smoke-doc.test.sh
set -uo pipefail

DOC="plan-v9.md"
PASS=0; FAIL=0
log() { printf "%s\n" "$*" >&2; }
ok()  { PASS=$((PASS+1)); log "  ok    $1"; }
err() { FAIL=$((FAIL+1)); log "  FAIL  $1: $2"; }

# Falsifier 1: smoke-results section header present
if zigrep "## Smoke results" "$DOC" >/dev/null 2>&1; then
  ok "section-header: 'Smoke results' section present"
else
  err "section-header" "missing '## Smoke results' section — verdict erased"
fi

# Falsifier 2: all 4 phases (B/C/D/E) accounted for
for phase in "B Kuri-CF" "C bundle-replay" "D DataDome" "E PerimeterX"; do
  if zigrep "$phase" "$DOC" >/dev/null 2>&1; then
    ok "phase-row[$phase]: documented"
  else
    err "phase-row[$phase]" "row missing — phase verdict erased"
  fi
done

# Falsifier 3: B's outcome (CF challenge 403) recorded
if zigrep "Security | Glassdoor" "$DOC" >/dev/null 2>&1 || zigrep "challenge page" "$DOC" >/dev/null 2>&1; then
  ok "phase-b-evidence: CF challenge evidence cited"
else
  err "phase-b-evidence" "Phase B smoke evidence missing"
fi

# Falsifier 4: D's non-determinism documented
if zigrep "[Nn]on-deterministic\|non.deterministic" "$DOC" >/dev/null 2>&1; then
  ok "phase-d-evidence: non-deterministic verdict cited"
else
  err "phase-d-evidence" "Phase D non-determinism not documented"
fi

# Falsifier 5: SKIP_C action present
if zigrep "SKIP_C\|SKIPPED" "$DOC" >/dev/null 2>&1; then
  ok "action[SKIP_C]: skip-C decision recorded"
else
  err "action[SKIP_C]" "decision action missing"
fi

# Falsifier 6: re-trigger conditions present (so future readers know when to revive)
if zigrep "Re-trigger conditions\|revives" "$DOC" >/dev/null 2>&1; then
  ok "re-trigger-conditions: revive triggers documented"
else
  err "re-trigger-conditions" "no documented path to revive Phase C/D/E"
fi

# Falsifier 7: cost-summary cites time saved
if zigrep "Saved\|saved.*hours\|saved.*hr" "$DOC" >/dev/null 2>&1; then
  ok "cost-summary: time-saved evidence cited (smoke gates working as designed)"
else
  err "cost-summary" "no time-saved evidence — smoke gate value invisible"
fi

# Falsifier 8: zero new code claim explicit
if zigrep "Zero new code\|zero new code\|0 LoC\|No new module" "$DOC" >/dev/null 2>&1; then
  ok "zero-code-claim: explicit no-code-shipped declaration present"
else
  err "zero-code-claim" "missing explicit zero-code declaration; future readers may assume code exists"
fi

log ""
log "plan-v9-smoke-doc.test.sh: PASS=$PASS FAIL=$FAIL"
[ "$FAIL" -eq 0 ] || exit 1
