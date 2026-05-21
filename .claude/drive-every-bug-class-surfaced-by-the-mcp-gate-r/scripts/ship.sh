#!/usr/bin/env bash
# ship.sh - surface the next /meta-harness target(s) from the latest bench-gate run.
#
# Substrate-faithful: this script does NOT pick a fix. It SURFACES the
# top-N highest-impact failing probes from next-blocker.sh, each with a
# suggested fix-shape + ready-to-run /meta-harness build command. The
# agent in-thread reads the list and decides which to act on.
#
# Output:
#   - Top-N blocker list (default 3) with: probe_id, lane, verdicts,
#     suggested fix-shape, and the exact `harness build "<plan>"` command
#   - Recent merged PRs from the unbrowse-improvement-loop (context for what
#     fixes are already in flight)

set -uo pipefail
SCAFFOLD="$(cd "$(dirname "$0")/.." && pwd)"
PROJECT="$(cd "$SCAFFOLD/../.." && pwd)"
cd "$PROJECT"
TOP_N="${UNBROWSE_SHIP_TOP_N:-3}"

LATEST=$(ls -dt .bench-gate/20260*/ 2>/dev/null | head -1)
LATEST="${LATEST%/}"
if [ -z "$LATEST" ] || [ ! -f "$LATEST/gate.json" ]; then
  echo "[ship] no gate.json found; run verify.sh first"
  exit 1
fi

GATE_PASSED=$(python3 -c "import json;print(json.load(open('$LATEST/gate.json')).get('passed'))")
echo "[ship] latest run: $LATEST"
echo "[ship] gate.passed: $GATE_PASSED"

if [ "$GATE_PASSED" = "True" ]; then
  echo "[ship] CONVERGED - no next blocker to surface."
  exit 0
fi
echo ""
echo "=== TOP $TOP_N NEXT-BLOCKER CANDIDATES ==="
echo "(agent judges in-thread which to act on; substrate surfaces only)"
echo ""

TMP_BLOCKERS=$(mktemp)
UNBROWSE_NEXT_BLOCKER_LIMIT="$TOP_N" bash "$SCAFFOLD/scripts/next-blocker.sh" "$LATEST" >"$TMP_BLOCKERS" 2>/dev/null
python3 - "$TMP_BLOCKERS" <<'PYEOF'
import json, sys
path = sys.argv[1]
rows = [json.loads(line) for line in open(path) if line.strip().startswith("{")]
for i, r in enumerate(rows, 1):
    print(f"--- candidate #{i} (impact-score {r['score']}) ---")
    print(f"  probe:      {r['probe_id']}")
    print(f"  lane:       {r['lane']}")
    print(f"  url:        {r['url']}")
    print(f"  intent:     {r['intent']}")
    print(f"  index:      {r['index_verdict']}")
    print(f"  retrieve:   {r['retrieve_verdict']}")
    cm = r.get("capture_meta", {})
    print(f"  capture:    indexed={cm.get('indexed')} n_ops={cm.get('n_operations')} mode={cm.get('mode')!r}")
    blocks = cm.get("browser_block_signals", []) or []
    if blocks:
        print(f"  blocks:     {blocks}")
    diag = cm.get("capture_diagnostic", {}) or {}
    if diag:
        print(f"  diag:       {diag}")
    iso = cm.get("iso_self_check", {}) or {}
    if iso.get("host_match") is False:
        print(f"  iso_check:  HOST_MISMATCH intended={iso.get('intended_host')} actual={iso.get('snap_host')}")
    print(f"  fix-shape:  {r['suggested_fix_shape']}")
    plan = r['suggested_meta_harness_plan'].replace('"', '\\"')
    print()
    print(f"  next /meta-harness invocation:")
    print(f'    bash ~/.claude/skills/meta-harness/scripts/harness build "{plan}"')
    print()
PYEOF
rm -f "$TMP_BLOCKERS"

echo ""
echo "=== RECENT FIX PRs (context for what's in flight) ==="
if command -v gh >/dev/null 2>&1; then
  gh pr list --state merged --limit 8 \
    --search "in:title fix" \
    --json number,title,mergedAt \
    -q '.[]|"#\(.number) [\(.mergedAt | split("T")[0])] \(.title)"' 2>/dev/null | head -8
fi
echo ""
echo "[ship] when the agent has picked a candidate + shipped a PR, re-run verify.sh to measure delta."
exit 0
