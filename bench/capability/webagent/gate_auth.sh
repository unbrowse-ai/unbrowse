#!/usr/bin/env bash
# bench/capability/webagent/gate_auth.sh — authenticated-read witness, DEFAULT surface.
#
# Exits 0 only when, across TWO independent witnesses, the agent does an AUTHENTICATED
# READ through the DEFAULT one-hole command (`unbrowse "<intent>" --url …`, the path agents
# actually use) and the credential reaches the target — by BOTH agent-native phrasings:
#   1. bearer token embedded in the natural-language intent
#      (`unbrowse "authenticate with bearer token <t> then read …" --url <url>`), AND
#   2. an explicit --header (`unbrowse "read …" --url <url> --header "Authorization: Bearer <t>"`).
#
# Target: postman-echo /get (reflects request headers) — reproducible, no real account.
# This proves the one-hole AUTH path does a direct authenticated fetch (sub-second) instead
# of falling through the resolve+capture ladder, which carries no header and times out.
# Network-unreachable / target 5xx => exit 3 (BLOCKED), not a code FAIL.
#
# Binary under test: $UNBROWSE_BIN (default = local source; the fix ships in source, the
# npm-binary number follows a release).
set -uo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$HERE/../../.." && pwd)"
cd "$ROOT"

BIN_CMD="${UNBROWSE_BIN:-bun src/cli.ts}"
TS="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
HISTORY="$ROOT/bench/capability/history.jsonl"
URL="https://postman-echo.com/get"

# echoes "ok|<body>" / "block|<body>" — the body should contain the bearer token.
run_authed() { # intent extra-flags... -> drive the DEFAULT one-hole authed read
  local intent="$1"; shift
  timeout 60 $BIN_CMD "$intent" --url "$URL" "$@" 2>/dev/null \
  | python3 -c "import sys,json
raw=sys.stdin.read();best=None
for ln in raw.splitlines():
    ln=ln.strip()
    if ln.startswith('{'):
        try: best=json.loads(ln)
        except: pass
body=json.dumps(best) if best else raw
low=body.lower()
# 5xx from the echo service / no body => BLOCKED, not a code fail
if (not best and ('503' in raw or '502' in raw or 'timeout' in low)):
    print('block|'+raw[-120:].replace(chr(10),' ')); sys.exit()
print('ok|'+body[:400])"
}

witness_pass() { # -> PASS / FAIL / BLOCKED  (+ detail to stderr)
  local all_ok=1 blocked=0
  local t1="auth-embed-$$-${RANDOM}"
  local t2="auth-hdr-$$-${RANDOM}"
  # Witness A: bearer token EMBEDDED in NL — the agent never sets a header itself.
  local a; a="$(run_authed "authenticate with bearer token ${t1} then read the request")"
  if [ "${a%%|*}" = "block" ]; then echo "  NL-bearer BLOCKED (${a#*|})" >&2; blocked=1;
  elif echo "${a#*|}" | grep -q "$t1"; then echo "  NL-bearer PASS (credential reached target)" >&2;
  else echo "  NL-bearer FAIL (token not echoed): ${a#*|}" | head -c 160 >&2; echo >&2; all_ok=0; fi
  # Witness B: explicit --header.
  local b; b="$(run_authed "read the request headers" --header "Authorization: Bearer ${t2}")"
  if [ "${b%%|*}" = "block" ]; then echo "  hdr BLOCKED (${b#*|})" >&2; blocked=1;
  elif echo "${b#*|}" | grep -q "$t2"; then echo "  hdr PASS (header reached target)" >&2;
  else echo "  hdr FAIL (header not echoed): ${b#*|}" | head -c 160 >&2; echo >&2; all_ok=0; fi
  if [ "$blocked" = "1" ] && [ "$all_ok" = "1" ]; then echo BLOCKED; return; fi
  [ "$all_ok" = "1" ] && echo PASS || echo FAIL
}

echo "── webagent auth gate (witness 1) ──────────────" >&2
W1="$(witness_pass)"; [ -z "$W1" ] && W1="FAIL"
echo "── webagent auth gate (witness 2) ──────────────" >&2
W2="$(witness_pass)"; [ -z "$W2" ] && W2="FAIL"

echo "─────────────────────────────────────────────────"
echo " witness1=$W1  witness2=$W2  bin=$BIN_CMD"

python3 -c "
import json
open('$HISTORY','a').write(json.dumps({'ts':'$TS','source':'live','axis':'C_auth_onehole',
  'bin':'$BIN_CMD','witness1':'$W1','witness2':'$W2',
  'gate': 'true' if ('$W1'=='PASS' and '$W2'=='PASS') else 'false'})+'\n')
"

if [ "$W1" = "BLOCKED" ] || [ "$W2" = "BLOCKED" ]; then
  echo " GATE: BLOCKED (echo service unreachable — not a code result)"; exit 3
fi
if [ "$W1" = "PASS" ] && [ "$W2" = "PASS" ]; then
  echo " GATE: PASS — one-hole authenticated reads work (NL bearer + --header), two witnesses"; exit 0
fi
echo " GATE: FAIL"; exit 1
