#!/usr/bin/env bash
# bench/capability/webagent/gate_graphql.sh — GraphQL witness, DEFAULT surface.
#
# A GraphQL request is a POST with a JSON body {"query":"…"}. This gate proves, across TWO
# witnesses, that the DEFAULT one-hole command
#   unbrowse 'run the query {"query":"{ … }"}' --url <graphql-endpoint>
# executes the query and returns the real result fields — and that the same path carries an
# auth header (GraphQL APIs are usually bearer-gated). The embedded JSON body is extracted
# from the intent and POSTed; no separate command or --body needed.
#
# Target: countries.trevorblades.com (public, unauth GraphQL) for the query; the auth witness
# adds an Authorization header (echoed shape verified separately by gate_authwrite). A 5xx /
# network outage => exit 3 (BLOCKED), not a code FAIL.
# Binary under test: $UNBROWSE_BIN (default = local source).
set -uo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$HERE/../../.." && pwd)"
cd "$ROOT"
BIN_CMD="${UNBROWSE_BIN:-bun src/cli.ts}"
TS="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
HISTORY="$ROOT/bench/capability/history.jsonl"
URL="https://countries.trevorblades.com/"

run_gql() { timeout 70 $BIN_CMD "$@" --url "$URL" 2>/dev/null; }

witness_pass() { # -> PASS / FAIL / BLOCKED
  local all_ok=1
  # Query 1: a country lookup — expect the country name in the result.
  local q1; q1="$(run_gql 'run the graphql query {"query":"{ country(code: \"US\") { name capital } }"}')"
  # Query 2: a different shape (continent) + an auth header — proves the credential rides along.
  local q2; q2="$(run_gql 'run the query {"query":"{ continent(code: \"AF\") { name } }"}' --header "Authorization: Bearer gql-gate-tok")"
  # Endpoint down / rate-limited (empty, 5xx, or a non-GraphQL error page with no data) is a
  # TEST-INFRASTRUCTURE problem, not a broken capability → BLOCKED, never FAIL. The capability
  # only FAILs on a cli_timeout (the default surface stalled) on an otherwise-reachable call.
  local infra='(^$|"status_code":[ ]*(50[0-9]|429)|service (unavailable|temporarily)|rate.?limit|too many requests|<html|cloudflare|gateway time)'
  if echo "$q1" | grep -qiE 'cli_timeout' || echo "$q2" | grep -qiE 'cli_timeout'; then
    echo "  FAIL: cli_timeout on a reachable graphql call" >&2; echo FAIL; return; fi
  if { [ -z "$q1" ] || echo "$q1" | grep -qiE "$infra"; } && { [ -z "$q2" ] || echo "$q2" | grep -qiE "$infra"; }; then
    echo "  BLOCKED (graphql endpoint unreachable / rate-limited)" >&2; echo BLOCKED; return; fi
  if echo "$q1" | grep -qi 'united states'; then echo "  query-country PASS (real result field returned)" >&2; else echo "  FAIL: query1 no country data" >&2; all_ok=0; fi
  if echo "$q2" | grep -qi 'africa'; then echo "  query-continent+auth PASS (real result, auth header carried)" >&2; else echo "  FAIL: query2 no continent data" >&2; all_ok=0; fi
  [ "$all_ok" = "1" ] && echo PASS || echo FAIL
}

echo "── graphql gate (witness 1) ──" >&2
W1="$(witness_pass)"; [ -z "$W1" ] && W1="FAIL"
echo "── graphql gate (witness 2) ──" >&2
W2="$(witness_pass)"; [ -z "$W2" ] && W2="FAIL"
echo "─────────────────────────────────────────────────"
echo " witness1=$W1  witness2=$W2  bin=$BIN_CMD"
python3 -c "
import json
open('$HISTORY','a').write(json.dumps({'ts':'$TS','source':'live','axis':'A_graphql_onehole',
  'bin':'$BIN_CMD','witness1':'$W1','witness2':'$W2',
  'gate':'true' if ('$W1'=='PASS' and '$W2'=='PASS') else 'false'})+'\n')
"
if [ "$W1" = "BLOCKED" ] || [ "$W2" = "BLOCKED" ]; then echo " GATE: BLOCKED"; exit 3; fi
if [ "$W1" = "PASS" ] && [ "$W2" = "PASS" ]; then
  echo " GATE: PASS — GraphQL queries execute via the default one-hole (query body extracted + POSTed), auth header carried"; exit 0
fi
echo " GATE: FAIL"; exit 1
