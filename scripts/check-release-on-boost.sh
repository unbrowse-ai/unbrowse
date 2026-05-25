#!/usr/bin/env bash
#
# scripts/check-release-on-boost.sh
#
# Release-trigger gate. Compares the current dimensional-bench coverage
# against the last shipped release's coverage. When the delta is >= 10
# percentage points, prints a release-recommended line; otherwise stays
# silent.
#
# Substrate-faithful: surfaces evidence, never auto-fires release-it.
# The agent (or the operator) reads the recommendation and decides.
#
# State:
#   .release-coverage-baseline  — the last shipped coverage (float 0..1)
#                                  written by scripts/release-and-verify
#                                  after a successful tag push.
#   .bench-local/results.jsonl  — current bench data (per existing
#                                  dimensional-summary).
#
# Exit 0 always. Output:
#   no-baseline | baseline=<x>% current=<y>% delta=<z>pp recommend-release={yes|no}

set -euo pipefail
cd "$(dirname "$0")/.."

BASELINE_FILE=".release-coverage-baseline"
RESULTS=".bench-local/results.jsonl"

if [ ! -f "$RESULTS" ]; then
  echo "[release-boost] no bench results — skip"
  exit 0
fi

current=$(python3 - "$RESULTS" <<'PY'
import sys, json
results_path = sys.argv[1]
total = 0
passed = 0
for ln in open(results_path):
    if not ln.strip(): continue
    try:
        r = json.loads(ln)
    except json.JSONDecodeError:
        continue
    total += 1
    if r.get("verdict") == "PASS":
        passed += 1
if total == 0:
    print("0")
else:
    print(f"{passed/total:.4f}")
PY
)

if [ ! -f "$BASELINE_FILE" ]; then
  echo "[release-boost] no baseline — current=${current} (writes baseline on first release)"
  exit 0
fi

baseline=$(cat "$BASELINE_FILE")

python3 - "$baseline" "$current" <<'PY'
import sys
baseline = float(sys.argv[1])
current = float(sys.argv[2])
delta = current - baseline
delta_pp = delta * 100
recommend = "yes" if delta_pp >= 10.0 else "no"
print(f"[release-boost] baseline={baseline*100:.1f}% current={current*100:.1f}% delta={delta_pp:+.1f}pp recommend-release={recommend}")
PY
