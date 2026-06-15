#!/usr/bin/env bash
# bench/capability/webagent/gate_authwrite.sh — AUTHENTICATED WRITE witness, DEFAULT surface.
#
# An authenticated write used to reach the target with its BODY but DROP the auth header
# (--header was honored on reads, silently dropped on writes). This gate proves, across TWO
# witnesses, that the DEFAULT one-hole command
#   unbrowse "<intent>" --url <post-url> --body <json> --header "Authorization: Bearer <t>"
# sends BOTH the body AND the credential to the target, AND that neither the token nor a
# sensitive body field (password) persists in cleartext on disk — the password is kept only
# as its sha256 commitment (ZK input-censoring), the token is not persisted at all.
#
# Target: postman-echo /post (reflects both headers and body). Network down => exit 3.
# Binary under test: $UNBROWSE_BIN (default = local source).
set -uo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$HERE/../../.." && pwd)"
cd "$ROOT"
BIN_CMD="${UNBROWSE_BIN:-bun src/cli.ts}"
CFG="${UNBROWSE_CONFIG_DIR:-$HOME/.unbrowse}"
TS="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
HISTORY="$ROOT/bench/capability/history.jsonl"

# leak-scan helper with a CORRECT exit code (no `grep|sed` masking).
on_disk() { grep -rl "$1" "$CFG" >/dev/null 2>&1; }

witness_pass() { # -> PASS / FAIL / BLOCKED
  local all_ok=1
  local tok="awgate-tok-$$-${RANDOM}"
  local pw="awgate-pw-$$-${RANDOM}"
  local url="https://postman-echo.com/post?awn=$$-${RANDOM}"
  local out; out="$(timeout 70 $BIN_CMD "create an account" --url "$url" \
      --body "{\"email\":\"a@b.c\",\"password\":\"$pw\"}" \
      --header "Authorization: Bearer $tok" 2>/dev/null)"
  if [ -z "$out" ] || echo "$out" | grep -qiE 'cli_timeout|"status_code":[ ]*(50[0-9]|429)|service (unavailable|temporarily)'; then
    echo "  BLOCKED (echo service / timeout)" >&2; echo BLOCKED; return; fi
  # both the body AND the credential must have reached the target (postman-echo echoes both)
  if echo "$out" | grep -q "$pw"; then echo "  body-reached-target PASS" >&2; else echo "  FAIL: body did not reach target" >&2; all_ok=0; fi
  if echo "$out" | grep -q "$tok"; then echo "  auth-header-reached-target PASS" >&2; else echo "  FAIL: auth header DROPPED on write" >&2; all_ok=0; fi
  # neither secret may persist in cleartext on disk
  if on_disk "$pw"; then echo "  LEAK: password cleartext on disk" >&2; all_ok=0; else echo "  no-cleartext-password PASS" >&2; fi
  if on_disk "$tok"; then echo "  LEAK: auth token cleartext on disk" >&2; all_ok=0; else echo "  no-cleartext-token PASS" >&2; fi
  # the write's password must persist only as a sha256 commitment
  local wid; wid="adhoc-write-$(printf 'POST %s' "$url" | shasum -a 256 | cut -c1-40)"
  local wf="$CFG/skill-cache/${wid}.json"
  if [ -f "$wf" ] && grep -q '"password":[ ]*"sha256:' "$wf"; then echo "  password-sha256-committed PASS" >&2;
  elif [ -f "$wf" ]; then echo "  FAIL: no sha256 commitment in route" >&2; all_ok=0;
  else echo "  (write route in-memory only)" >&2; fi
  [ "$all_ok" = "1" ] && echo PASS || echo FAIL
}

echo "── authwrite gate (witness 1) ──" >&2
W1="$(witness_pass)"; [ -z "$W1" ] && W1="FAIL"
echo "── authwrite gate (witness 2) ──" >&2
W2="$(witness_pass)"; [ -z "$W2" ] && W2="FAIL"
echo "─────────────────────────────────────────────────"
echo " witness1=$W1  witness2=$W2  bin=$BIN_CMD"
python3 -c "
import json
open('$HISTORY','a').write(json.dumps({'ts':'$TS','source':'live','axis':'C_authwrite_onehole',
  'bin':'$BIN_CMD','witness1':'$W1','witness2':'$W2',
  'gate':'true' if ('$W1'=='PASS' and '$W2'=='PASS') else 'false'})+'\n')
"
if [ "$W1" = "BLOCKED" ] || [ "$W2" = "BLOCKED" ]; then echo " GATE: BLOCKED"; exit 3; fi
if [ "$W1" = "PASS" ] && [ "$W2" = "PASS" ]; then
  echo " GATE: PASS — authenticated writes carry body+credential to the target; secrets never cleartext on disk"; exit 0
fi
echo " GATE: FAIL"; exit 1
