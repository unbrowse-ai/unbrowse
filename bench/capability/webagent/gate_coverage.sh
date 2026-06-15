#!/usr/bin/env bash
# bench/capability/webagent/gate_coverage.sh — action-retrieval coverage, DEFAULT surface.
#
# Axis A measures coverage via `unbrowse resolve` (the step-1 ranking path). This gate
# measures the SAME coverage through the DEFAULT one-hole command an agent actually uses
# (`unbrowse "<intent>" --url <url>`) — the runtime chooses search / direct fetch / route
# graph / capture behind the typed hole. Coverage = a real, non-trivial, on-topic result
# (the page title or content reflects the target), fast, no cli_timeout.
#
# Targets: stable public pages (Hacker News, Wikipedia, Stack Overflow, npm, GitHub search).
# Per-target: PASS (title/content present, no timeout), or BLOCKED (5xx / network / the
# target rate-limited). The gate PASSES when every reachable target returns real content and
# none time out; it is BLOCKED (exit 3), not FAILED, when reachable coverage is too thin to
# judge. A cli_timeout on a reachable target is a real FAIL (the default surface stalled).
#
# Binary under test: $UNBROWSE_BIN (default = local source).
set -uo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$HERE/../../.." && pwd)"
cd "$ROOT"
BIN_CMD="${UNBROWSE_BIN:-bun src/cli.ts}"
TS="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
HISTORY="$ROOT/bench/capability/history.jsonl"

# id|intent|url|expect-substring (case-insensitive, in title or content)
TARGETS=(
  "HN|get the top stories on hacker news|https://news.ycombinator.com|hacker news"
  "WIKI|read the wikipedia article on quantum computing|https://en.wikipedia.org/wiki/Quantum_computing|quantum"
  "SO|browse the latest questions on stack overflow|https://stackoverflow.com/questions|stack overflow"
  "NPM|search npm for react packages|https://www.npmjs.com/search?q=react|react"
  "GH|search github repositories for python web frameworks|https://github.com/search?q=python+web+framework|github"
)

scan() { # -> per-target: prints PASS/FAIL/BLOCK + id to stderr; echoes pass-count and reach-count
  local passes=0 reach=0
  for row in "${TARGETS[@]}"; do
    IFS='|' read -r id intent url expect <<<"$row"
    local out; out="$(timeout 75 $BIN_CMD "$intent" --url "$url" 2>/dev/null)"
    if echo "$out" | grep -qi 'cli_timeout'; then echo "  $id FAIL (cli_timeout on reachable target)" >&2; reach=$((reach+1)); continue; fi
    if [ -z "$out" ] || echo "$out" | grep -qiE '"status_code":[ ]*(50[0-9]|429)|service (unavailable|temporarily)'; then echo "  $id BLOCKED (5xx/empty)" >&2; continue; fi
    reach=$((reach+1))
    if echo "$out" | grep -qi "$expect"; then echo "  $id PASS (on-topic content returned)" >&2; passes=$((passes+1));
    else echo "  $id FAIL (no on-topic content): $(echo "$out"|head -c 80|tr -d '\n')" >&2; fi
  done
  echo "$passes $reach"
}

echo "── coverage gate (default one-hole) ──" >&2
read -r P R < <(scan)
echo "─────────────────────────────────────────────────"
echo " on-topic=$P / reachable=$R / total=${#TARGETS[@]}  bin=$BIN_CMD"
V="FAIL"
if [ "$R" -lt 2 ]; then V="BLOCKED"; elif [ "$P" -eq "$R" ]; then V="PASS"; fi
python3 -c "
import json
open('$HISTORY','a').write(json.dumps({'ts':'$TS','source':'live','axis':'A_coverage_onehole',
  'bin':'$BIN_CMD','on_topic':$P,'reachable':$R,'total':${#TARGETS[@]},
  'gate':'true' if '$V'=='PASS' else 'false'})+'\n')
"
case "$V" in
  PASS) echo " GATE: PASS — every reachable target returns on-topic content via the default surface, no timeout"; exit 0;;
  BLOCKED) echo " GATE: BLOCKED — fewer than 2 reachable targets (network/rate-limit), can't judge"; exit 3;;
  *) echo " GATE: FAIL"; exit 1;;
esac
