#!/usr/bin/env bash
# Adversarial fixture for tests/decision-trace-naming.test.sh.
# Injects 4 lost-sheep step names (each violates a different rule) and asserts
# the falsifier catches every one. If any pass through, the candlestick is
# hollow and the convention test is decorative, not falsifiable.
#
# Run: bash tests/decision-trace-naming-adversarial.test.sh
set -uo pipefail

PASS=0; FAIL=0
log() { printf "%s\n" "$*" >&2; }
ok()  { PASS=$((PASS+1)); log "  ok    $1"; }
err() { FAIL=$((FAIL+1)); log "  FAIL  $1: $2"; }

RESERVED='^(probe|decision|server|browser|browser_default|browser_fallback|trigger_intercept|return_error|recipe_replay|auth_recovery|server_fetch|5xx|4xx|401|403|400|404|429|page_fetch|ssr_fastpath|vendor_block|bundle_replay)'

# Each row: name|expected_fail_rule
ADVERSARIAL=(
  "ServerFetch|uppercase"          # camelCase — must fail uppercase rule
  "we tried server fetch|space"    # sentence-shape with spaces — must fail space rule
  "server_fetch_500|status-suffix" # embeds status as suffix — must fail status-suffix rule
  "did_a_thing|scope-prefix"       # not on reserved scope list — must fail scope-prefix rule
)

for row in "${ADVERSARIAL[@]}"; do
  name="${row%%|*}"
  rule="${row##*|}"
  caught=0

  case "$rule" in
    uppercase)
      [[ "$name" =~ [A-Z] ]] && caught=1
      ;;
    space)
      [[ "$name" =~ [[:space:]] ]] && caught=1
      ;;
    status-suffix)
      [[ "$name" =~ _[0-9]{3}$ ]] && caught=1
      ;;
    scope-prefix)
      [[ "$name" =~ $RESERVED ]] || caught=1
      ;;
  esac

  if [ "$caught" -eq 1 ]; then
    ok "adversarial[$rule]: '$name' correctly rejected"
  else
    err "adversarial[$rule]" "'$name' slipped past the $rule gate"
  fi
done

# Positive control: a known-good name MUST pass all gates
GOOD="auth_recovery_retry"
control_ok=1
[[ "$GOOD" =~ ^[a-z0-9_]+$ ]] || control_ok=0
[[ "$GOOD" =~ $RESERVED ]] || control_ok=0
[[ "$GOOD" =~ [[:space:]] ]] && control_ok=0
[[ "$GOOD" =~ [A-Z] ]] && control_ok=0
[[ "$GOOD" =~ _[0-9]{3}$ ]] && control_ok=0
if [ "$control_ok" -eq 1 ]; then
  ok "positive-control: 'auth_recovery_retry' passes all gates"
else
  err "positive-control" "known-good name was rejected"
fi

log ""
log "decision-trace-naming-adversarial.test.sh: PASS=$PASS FAIL=$FAIL"
[ "$FAIL" -eq 0 ] || exit 1
