#!/usr/bin/env bash
# measure.sh - fire a fresh bench-gate run when needed; reuse otherwise.
#
# Substrate-faithful: this script COLLECTS evidence. It does NOT classify
# probes, decide PASS/FAIL, or pick the next fix. Those live in the
# agent-judged loop downstream (verify.sh + ship.sh + the agent in-thread).
#
# Idempotent skip:
#   If the latest .bench-gate/20260*/ directory has all 66 capture.meta.json
#   files AND is younger than UNBROWSE_BENCH_MAX_AGE_MIN (default 120 min),
#   skip the new run and exit 0 with the existing path.
#
# Otherwise:
#   Mint a new run-id, copy the latest manifest, fire
#   bun scripts/mcp-gate-parallel-collect.ts <run-dir> at the declared
#   concurrency, then wait. Conc=1 is the default because bench-gate runs
#   at conc>1 have produced session cross-contamination (002 npmjs
#   cycle-4: snap landed on saiful.pages.dev/tasks). The agent JUDGES
#   whether to raise concurrency for speed at the cost of isolation.
#
# Env:
#   UNBROWSE_BENCH_MAX_AGE_MIN  (default 120)  - reuse window for latest run
#   UNBROWSE_BENCH_CONCURRENCY  (default 1)    - collector worker pool
#   UNBROWSE_BENCH_PROBE_TIMEOUT_MS (default 90000) - per-probe ceiling
#   UNBROWSE_BENCH_FORCE        (1|true)       - fire a new run even if fresh
#
# Output:
#   Prints the chosen run-dir to stdout. Stderr: progress logs.
#   Writes nothing to scaffold state; the iterate driver reads stdout.

set -uo pipefail
SCAFFOLD="$(cd "$(dirname "$0")/.." && pwd)"
PROJECT="$(cd "$SCAFFOLD/../.." && pwd)"
cd "$PROJECT"

MAX_AGE_MIN="${UNBROWSE_BENCH_MAX_AGE_MIN:-120}"
CONC="${UNBROWSE_BENCH_CONCURRENCY:-1}"
PROBE_TIMEOUT_MS="${UNBROWSE_BENCH_PROBE_TIMEOUT_MS:-90000}"
FORCE="${UNBROWSE_BENCH_FORCE:-0}"

LATEST=$(ls -dt .bench-gate/20260*/ 2>/dev/null | head -1)
LATEST_NORMALIZED="${LATEST%/}"

probe_count() {
  local dir="$1"
  [ -d "$dir" ] || { echo 0; return; }
  ls -d "$dir"/0*_*/ 2>/dev/null | wc -l | tr -d ' '
}
manifest_probe_count() {
  local dir="$1"
  [ -f "$dir/manifest.json" ] || { echo 0; return; }
  python3 -c "import json; print(len(json.load(open('$dir/manifest.json')).get('probes', [])))" 2>/dev/null || echo 0
}

if [ -n "$LATEST" ] && [ "$FORCE" != "1" ] && [ "$FORCE" != "true" ]; then
  expected=$(manifest_probe_count "$LATEST_NORMALIZED")
  actual=$(probe_count "$LATEST_NORMALIZED")
  if [ "$expected" -gt 0 ] && [ "$actual" = "$expected" ]; then
    age_min=$(python3 -c "
import os, time
mtime = os.path.getmtime('$LATEST_NORMALIZED')
print(int((time.time() - mtime) / 60))
" 2>/dev/null || echo 9999)
    if [ "$age_min" -le "$MAX_AGE_MIN" ]; then
      echo "[measure] reusing $LATEST_NORMALIZED ($actual/$expected probes, ${age_min}min old, max-age=${MAX_AGE_MIN}min)" >&2
      echo "$LATEST_NORMALIZED"
      exit 0
    fi
    echo "[measure] $LATEST_NORMALIZED is ${age_min}min old (max-age=${MAX_AGE_MIN}min); firing fresh run" >&2
  else
    echo "[measure] $LATEST_NORMALIZED incomplete ($actual/$expected probes); firing fresh run" >&2
  fi
fi

# Mint a new run from the latest manifest as template (preserves corpus)
RUN_ID=$(date -u +"%Y%m%dT%H%M%SZ")
RUN_DIR=".bench-gate/$RUN_ID"
mkdir -p "$RUN_DIR"
if [ -n "$LATEST" ] && [ -f "$LATEST_NORMALIZED/manifest.json" ]; then
  python3 -c "
import json
m = json.load(open('$LATEST_NORMALIZED/manifest.json'))
m['run_id'] = '$RUN_ID'
m['started_at'] = '$(date -u +%Y-%m-%dT%H:%M:%SZ)'
json.dump(m, open('$RUN_DIR/manifest.json', 'w'), indent=2)
print(f'[measure] copied manifest from $LATEST_NORMALIZED ({len(m[\"probes\"])} probes)', file=__import__('sys').stderr)
"
else
  echo "[measure] no prior manifest found; cannot seed corpus" >&2
  exit 1
fi

echo "[measure] firing collector run_dir=$RUN_DIR conc=$CONC probe_timeout=${PROBE_TIMEOUT_MS}ms" >&2
export UNBROWSE_GATE_CONCURRENCY="$CONC"
export UNBROWSE_GATE_PROBE_TIMEOUT_MS="$PROBE_TIMEOUT_MS"
export UNBROWSE_FORCE_HEADLESS=1
START=$(date +%s)
bun scripts/mcp-gate-parallel-collect.ts "$RUN_DIR" >"$RUN_DIR/collect.log" 2>&1
RC=$?
END=$(date +%s)
DUR=$((END-START))
captured=$(probe_count "$RUN_DIR")
expected=$(manifest_probe_count "$RUN_DIR")
echo "[measure] collector rc=$RC dur=${DUR}s captured=$captured/$expected" >&2
if [ "$RC" -ne 0 ] && [ "$captured" -lt "$expected" ]; then
  echo "[measure] collector failed (rc=$RC, partial=$captured/$expected); see $RUN_DIR/collect.log" >&2
  exit "$RC"
fi
echo "$RUN_DIR"
