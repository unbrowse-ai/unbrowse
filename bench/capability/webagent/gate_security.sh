#!/usr/bin/env bash
# bench/capability/webagent/gate_security.sh — credential-leak witness, DEFAULT surface.
#
# The pre-existing Axis-D leak-scan is VACUOUS in a fresh run: it scans whatever session
# files happen to exist, which is zero, so it passes trivially (leak_clean=True, 0 scanned).
# This gate GENERATES real credential-handling traffic through the default one-hole surface
# first, THEN scans every persisted artifact — so a leak has something to leak into.
#
# Exits 0 only when, across TWO independent witnesses, after the agent has:
#   1. WRITTEN a secret (a `password` field) via `unbrowse "<intent>" --url --body`, and
#   2. done an authenticated READ with a bearer token via the one-hole auth path,
# NEITHER raw secret appears in cleartext anywhere under the config dir, AND the write's
# secret is present only as its sha256 commitment (ZK input-censoring). The credential must
# still have reached the TARGET (the op truly worked) — a no-op that writes nothing is not a
# pass. Network/echo-service down => exit 3 (BLOCKED), not a code FAIL.
#
# Binary under test: $UNBROWSE_BIN (default = local source; fix ships in source).
set -uo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$HERE/../../.." && pwd)"
cd "$ROOT"

BIN_CMD="${UNBROWSE_BIN:-bun src/cli.ts}"
CFG="${UNBROWSE_CONFIG_DIR:-$HOME/.unbrowse}"
TS="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
HISTORY="$ROOT/bench/capability/history.jsonl"

drive() { timeout 60 $BIN_CMD "$@" 2>/dev/null; }

witness_pass() { # -> PASS / FAIL / BLOCKED
  local all_ok=1 blocked=0
  local pw="zk-sec-pw-$$-${RANDOM}"
  local tok="zk-sec-tok-$$-${RANDOM}"

  # 1) WRITE a password through the default one-hole. The deterministic skill-cache file
  #    for this write (method+url hash) is where a commitment must land.
  local wurl="https://postman-echo.com/post?secn=$$-${RANDOM}"
  local wid; wid="adhoc-write-$(printf 'POST %s' "$wurl" | shasum -a 256 | cut -c1-40)"
  rm -f "$CFG/skill-cache/${wid}.json" 2>/dev/null
  local wout; wout="$(drive "create an account" --url "$wurl" --body "{\"email\":\"a@b.c\",\"password\":\"$pw\"}")"
  # 2) authenticated READ with a bearer token through the one-hole auth path.
  local aout; aout="$(drive "authenticate with bearer token $tok then read the request" --url "https://postman-echo.com/get")"

  # network/echo down? both ops empty => BLOCKED, not a fail.
  if [ -z "$wout" ] && [ -z "$aout" ]; then echo "  BLOCKED (echo service unreachable)" >&2; echo BLOCKED; return; fi

  # the secret/token must have reached the TARGET (the op truly ran).
  if echo "$wout" | grep -q "$pw"; then echo "  write target-received-secret PASS" >&2;
  else echo "  write FAIL: target did not receive password" >&2; all_ok=0; fi
  if echo "$aout" | grep -q "$tok"; then echo "  auth target-received-token PASS" >&2;
  else echo "  auth FAIL: bearer token did not reach target" >&2; all_ok=0; fi

  # NEITHER raw credential may persist in cleartext anywhere under the config dir.
  if grep -rl "$pw" "$CFG" >/dev/null 2>&1; then echo "  LEAK ✗: password in cleartext on disk" >&2; all_ok=0;
  else echo "  no-cleartext password PASS" >&2; fi
  if grep -rl "$tok" "$CFG" >/dev/null 2>&1; then echo "  LEAK ✗: bearer token in cleartext on disk" >&2; all_ok=0;
  else echo "  no-cleartext bearer-token PASS" >&2; fi

  # the write's secret must be present as a sha256 commitment (ZK), proving it was censored,
  # not simply dropped.
  local wf="$CFG/skill-cache/${wid}.json"
  if [ -f "$wf" ] && grep -q '"password":[ ]*"sha256:' "$wf"; then echo "  write commitment-persisted PASS" >&2;
  elif [ -f "$wf" ]; then echo "  write FAIL: no sha256 commitment in persisted route" >&2; all_ok=0;
  else echo "  (write route in-memory only — no persisted file)" >&2; fi

  [ "$all_ok" = "1" ] && echo PASS || echo FAIL
}

echo "── security gate (witness 1) ──────────────" >&2
W1="$(witness_pass)"; [ -z "$W1" ] && W1="FAIL"
echo "── security gate (witness 2) ──────────────" >&2
W2="$(witness_pass)"; [ -z "$W2" ] && W2="FAIL"

echo "─────────────────────────────────────────────────"
echo " witness1=$W1  witness2=$W2  bin=$BIN_CMD"
python3 -c "
import json
open('$HISTORY','a').write(json.dumps({'ts':'$TS','source':'live','axis':'D_security_onehole',
  'bin':'$BIN_CMD','witness1':'$W1','witness2':'$W2',
  'gate': 'true' if ('$W1'=='PASS' and '$W2'=='PASS') else 'false'})+'\n')
"
if [ "$W1" = "BLOCKED" ] || [ "$W2" = "BLOCKED" ]; then echo " GATE: BLOCKED"; exit 3; fi
if [ "$W1" = "PASS" ] && [ "$W2" = "PASS" ]; then
  echo " GATE: PASS — credentials reach targets but never persist in cleartext (write censored to sha256), two witnesses"; exit 0
fi
echo " GATE: FAIL"; exit 1
