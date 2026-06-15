#!/usr/bin/env bash
# bench/capability/webagent/gate_indexing.sh — the API INDEXING / REUSE lever, gated.
#
# The north star: resolve+execute walk a prerequisite DAG, then PERSIST the walked
# composite route so a later call REPLAYS it instead of re-discovering — index once,
# reuse forever. Two independent witnesses, both unit-level (deterministic, no live
# network flakiness):
#
#   WITNESS 1 (persist + DAG): composite-persist + composite-dag-integration green —
#     a walked prerequisite sub-DAG is persisted and replayed; write-provides feed
#     downstream-requires across holes (the requires/yields DAG edges hold).
#   WITNESS 2 (reuse cache): cached-resolution green — a resolved endpoint is keyed
#     (domain,target) and served from the index on the next call, not re-resolved.
#
# Exit: 0 when both witness suites are green; 1 if either regresses; 3 (BLOCKED) if
# the toolchain can't run.
set -uo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$HERE/../../.." && pwd)"
cd "$ROOT"
TS="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
HISTORY="$ROOT/bench/capability/history.jsonl"
RUNNER="${UNBROWSE_TEST_RUNNER:-bun test}"

echo "── indexing / reuse gate (persist-walk → replay; resolution cache) ──" >&2
if ! command -v bun >/dev/null 2>&1; then
  echo " GATE: BLOCKED — no bun toolchain"; exit 3
fi

run_suite() { # files... -> echoes PASS/FAIL  (green iff bun reports 0 fail)
  local out; out="$(timeout 180 $RUNNER "$@" 2>&1)"
  if echo "$out" | grep -qE '^ *0 fail' && echo "$out" | grep -qE '^ *[1-9][0-9]* pass'; then
    echo "PASS"
  else
    echo "FAIL"; echo "$out" | grep -iE '\(fail\)|error' | head -3 >&2
  fi
}

W1="$(run_suite tests/composite-persist.test.ts tests/composite-dag-integration.test.ts)"
echo "  W1 $W1 — composite persist + DAG-replay (walk persisted, requires/yields edges)" >&2
W2="$(run_suite tests/cached-resolution.test.ts)"
echo "  W2 $W2 — cached resolution (resolved endpoint reused, not re-discovered)" >&2

echo "─────────────────────────────────────────────────"
echo " indexing: persist_replay=$W1  reuse_cache=$W2"
python3 -c "
import json
open('$HISTORY','a').write(json.dumps({'ts':'$TS','source':'live','axis':'indexing_reuse',
  'persist_replay':'$W1','reuse_cache':'$W2',
  'gate':'true' if ('$W1'=='PASS' and '$W2'=='PASS') else 'false'})+'\n')
"
if [ "$W1" = "PASS" ] && [ "$W2" = "PASS" ]; then
  echo " GATE: PASS — index-once/reuse works: walked composites persist + replay; resolutions are cached"
  exit 0
fi
echo " GATE: FAIL — an indexing/reuse witness regressed"
exit 1
