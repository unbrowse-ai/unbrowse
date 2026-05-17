#!/usr/bin/env bash
# <product_id>-evidence-bench.sh
# Reads the criteria.md rubric, runs each lane's `bench_signal` command, and writes one
# JSONL row to .bench-history/<product_id>-runs.jsonl with the raw output per lane.
# NEVER emits PASS/FAIL; the agent reads the row and judges.
set -uo pipefail

PRODUCT_ID="unbrowse-recompute-tiers"
REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
CRIT="$REPO_ROOT/.evidence-build/$PRODUCT_ID/criteria.md"
LEDGER_DIR="$REPO_ROOT/.bench-history"
LEDGER="$LEDGER_DIR/${PRODUCT_ID}-runs.jsonl"
mkdir -p "$LEDGER_DIR"

TS="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
RUN_ID="${PRODUCT_ID}-$(date -u +%Y%m%d-%H%M%S)-$$"

# Extract lanes from the rubric YAML block
python3 - "$CRIT" "$RUN_ID" "$TS" "$LEDGER" "$REPO_ROOT" <<'PY'
import json, os, re, subprocess, sys, yaml
crit, run_id, ts, ledger, repo = sys.argv[1:6]
text = open(crit).read()
m = re.search(r"```yaml\s*\n(.*?)\n```", text, re.S)
if not m:
    sys.exit("no yaml rubric block in criteria.md")
data = yaml.safe_load(m.group(1))
lanes = data.get("lanes", [])
by_lane = {}
for lane in lanes:
    lid = lane["id"]
    cmd = (lane.get("bench_signal") or "").strip()
    if not cmd:
        by_lane[lid] = {"skipped": "no bench_signal"}
        continue
    try:
        res = subprocess.run(
            ["bash", "-c", cmd],
            cwd=repo, capture_output=True, text=True, timeout=120,
        )
        by_lane[lid] = {
            "exit_code": res.returncode,
            "stdout": res.stdout[-8000:],
            "stderr": res.stderr[-2000:],
            "source_ids": lane.get("source_ids", []),
        }
    except subprocess.TimeoutExpired:
        by_lane[lid] = {"exit_code": -1, "error": "timeout-120s", "source_ids": lane.get("source_ids", [])}
    except Exception as e:
        by_lane[lid] = {"exit_code": -2, "error": str(e), "source_ids": lane.get("source_ids", [])}

row = {
    "run_id": run_id,
    "ts": ts,
    "product_id": "unbrowse-recompute-tiers",
    "lane_count": len(lanes),
    "by_lane": by_lane,
}
with open(ledger, "a") as f:
    f.write(json.dumps(row) + "\n")
print(f"wrote evidence row: run_id={run_id} lanes={len(lanes)} ledger={ledger}")
PY
