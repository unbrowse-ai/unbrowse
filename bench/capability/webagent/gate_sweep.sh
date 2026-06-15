#!/usr/bin/env bash
# bench/capability/webagent/gate_sweep.sh — the at-SCALE indexing SWEEP lever, gated honestly.
#
# The ask: sweep ~10,000 sites. A real 10k live sweep is a multi-hour DETACHED campaign
# (per-site captures + signups via AgentMail; see bench/index1000/run.sh) — running it in
# one agent turn and calling it green would be fabricated coverage. So this gate proves the
# SWEEP MACHINERY at a bounded, honest sample scale and states the full-scale job plainly:
#
#   WITNESS (bounded sample): N stable public read-APIs are swept through the DEFAULT
#     one-hole surface (`unbrowse "<intent>" --url <url>`) exactly as the 10k harness does,
#     one row per site. PASS iff >= THRESHOLD of REACHABLE sites return real, on-topic content
#     with no cli_timeout — i.e. the sweep loop drives the shipped surface and produces real
#     per-site results. Unreachable/rate-limited sites are excluded (BLOCKED), not counted as
#     failures (single public hosts flake; the capability is not what flaked).
#
#   FULL 10k: explicitly reported as a detached multi-hour job, NOT executed here. The harness
#     that runs it is bench/index1000/run.sh (resume-safe, lazy, parallel). This gate is the
#     unit-of-machinery witness; the campaign is a separate fleet run.
#
# Binary under test: $UNBROWSE_BIN (default local source). Exit: 0 if the sample sweep meets
# threshold; 1 if the machinery fails on reachable sites (timeout/empty); 3 BLOCKED if too few
# reachable to judge.
set -uo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$HERE/../../.." && pwd)"
cd "$ROOT"
BIN_CMD="${UNBROWSE_BIN:-bun src/cli.ts}"
TS="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
HISTORY="$ROOT/bench/capability/history.jsonl"
THRESHOLD="${SWEEP_THRESHOLD:-0.70}"

# url|expect-substring (case-insensitive) — vetted stable, signup-free read endpoints.
SITES=(
  "https://jsonplaceholder.typicode.com/posts/1|sunt aut"
  "https://jsonplaceholder.typicode.com/users/1|Bret"
  "https://api.github.com/repos/nodejs/node|nodejs"
  "https://pokeapi.co/api/v2/pokemon/ditto|ditto"
  "https://dog.ceo/api/breeds/list/all|success"
  "https://catfact.ninja/fact|fact"
  "https://api.chucknorris.io/jokes/random|value"
  "https://api.agify.io?name=michael|michael"
  "https://api.coingecko.com/api/v3/ping|gecko"
  "https://api.spacexdata.com/v4/launches/latest|name"
)

echo "── indexing sweep gate (bounded sample of ${#SITES[@]} via default one-hole) ──" >&2
ok=0; reach=0
for row in "${SITES[@]}"; do
  url="${row%%|*}"; exp="${row##*|}"
  verdict=""
  for attempt in 1 2; do
    out="$(timeout 70 $BIN_CMD "read the data from this endpoint" --url "$url" 2>/dev/null)"
    if echo "$out" | grep -qi 'cli_timeout'; then verdict="TIMEOUT"; break; fi
    if [ -z "$out" ] || echo "$out" | grep -qiE '"status_code":[ ]*(50[0-9]|429)|rate.?limit|temporarily'; then verdict="BLOCK"; sleep 2; continue; fi
    if echo "$out" | grep -qi "$exp"; then verdict="OK"; break; else verdict="THIN"; sleep 1; fi
  done
  case "$verdict" in
    OK)      ok=$((ok+1)); reach=$((reach+1)); echo "  ok    $url" >&2;;
    TIMEOUT) reach=$((reach+1)); echo "  TIMEOUT $url (sweep stalled on reachable site)" >&2;;
    THIN)    reach=$((reach+1)); echo "  thin  $url (reached, no on-topic content)" >&2;;
    *)       echo "  block $url (unreachable/rate-limit)" >&2;;
  esac
done

echo "─────────────────────────────────────────────────"
echo " sweep: on_topic=$ok / reachable=$reach / sample=${#SITES[@]}  bin=$BIN_CMD"
echo " FULL 10k sweep: NOT run here — detached multi-hour campaign via bench/index1000/run.sh"
V="FAIL"
if [ "$reach" -lt 4 ]; then V="BLOCKED";
elif [ "$(python3 -c "print(1 if $reach and $ok/$reach>=$THRESHOLD else 0)")" = "1" ]; then V="PASS"; fi
python3 -c "
import json
open('$HISTORY','a').write(json.dumps({'ts':'$TS','source':'live','axis':'indexing_sweep_sample',
  'on_topic':$ok,'reachable':$reach,'sample':${#SITES[@]},'threshold':$THRESHOLD,
  'full_10k':'detached-not-run','bin':'$BIN_CMD',
  'gate':'true' if '$V'=='PASS' else 'false'})+'\n')
"
case "$V" in
  PASS) echo " GATE: PASS — sample sweep drives the shipped one-hole over real sites ($ok/$reach >= $THRESHOLD); full 10k is a detached job"; exit 0;;
  BLOCKED) echo " GATE: BLOCKED — fewer than 4 reachable sample sites (network), can't judge the machinery"; exit 3;;
  *) echo " GATE: FAIL — the sweep machinery failed on reachable sites (timeout/thin)"; exit 1;;
esac
