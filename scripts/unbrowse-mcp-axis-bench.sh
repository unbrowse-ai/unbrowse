#!/usr/bin/env bash
# unbrowse-mcp evidence bench: emits raw per-lane evidence for the agent to judge.
#
# Reads .evidence-build/unbrowse-mcp/criteria.md (the YAML rubric block at the
# bottom), runs each lane's bench_signal bash block, dumps stdout+stderr to a
# per-run lane file, and writes ONE JSONL row per lane to the ledger.
#
# Hard rule: NO PASS/FAIL verdicts in this script. Just evidence. The agent
# in /unbrowse-self-build or /evidence-build reads the artifacts and judges.

set -u
set -o pipefail

cd "$(dirname "$0")/.."
REPO_ROOT="$(pwd)"
CRITERIA="$REPO_ROOT/.evidence-build/unbrowse-mcp/criteria.md"
LEDGER_DIR="$REPO_ROOT/.bench-history/unbrowse-mcp-runs"
RUN_ID="$(date -u +%Y%m%dT%H%M%SZ)"
RUN_DIR="$LEDGER_DIR/$RUN_ID"
LEDGER="$LEDGER_DIR/runs.jsonl"

mkdir -p "$RUN_DIR"

if [ ! -f "$CRITERIA" ]; then
  echo "[bench] criteria.md missing at $CRITERIA" >&2
  exit 2
fi

# Extract the rubric block (between the ```yaml fence after "## Rubric" and the
# closing ``` fence). Use awk for portability across macOS + Linux.
RUBRIC_YAML="$RUN_DIR/rubric.yaml"
awk '
  /^## Rubric/ { in_section = 1; next }
  in_section && /^```yaml/ { in_yaml = 1; next }
  in_yaml && /^```/ { in_yaml = 0; exit }
  in_yaml { print }
' "$CRITERIA" > "$RUBRIC_YAML"

if [ ! -s "$RUBRIC_YAML" ]; then
  echo "[bench] rubric block not found in $CRITERIA" >&2
  exit 3
fi

# Walk lanes. We do a portable YAML walk using awk: each "- id: <lane>" anchors
# a lane block; "bench_signal: |" starts an indented heredoc-style block we
# capture verbatim until the next sibling key.
TMP_LANES="$RUN_DIR/lanes.txt"
awk '
  function flush_lane() {
    if (lane != "") {
      print lane "\t" axis "\t" desc
    }
  }
  /^[[:space:]]*- id:[[:space:]]*lane-/ {
    flush_lane()
    lane = $NF
    desc = ""
    next
  }
  /^[[:space:]]*- id:[[:space:]]*[^l]/ {
    # out_of_scope ids start with "out-", skip
    flush_lane()
    lane = ""
    next
  }
  /^[[:space:]]*description:/ {
    sub(/^[[:space:]]*description:[[:space:]]*/, "")
    desc = $0
    next
  }
  /^  - id: indexing/ { axis = "indexing"; next }
  /^  - id: retrieval/ { axis = "retrieval"; next }
  /^  - id: execution/ { axis = "execution"; next }
  END { flush_lane() }
' "$RUBRIC_YAML" > "$TMP_LANES"

if [ ! -s "$TMP_LANES" ]; then
  echo "[bench] no lanes parsed from rubric" >&2
  exit 4
fi

LANE_COUNT=$(wc -l < "$TMP_LANES" | tr -d ' ')
echo "[bench] run_id=$RUN_ID lanes=$LANE_COUNT" >&2

# Walk again for bench_signal blocks. Map lane -> signal-script-path.
python3 - "$RUBRIC_YAML" "$RUN_DIR" <<'PYEOF'
import re, sys, os
rubric_path, run_dir = sys.argv[1], sys.argv[2]
text = open(rubric_path).read()
lane_re = re.compile(r"^\s*- id:\s*(lane-[a-z0-9-]+)\s*$", re.M)
positions = [(m.group(1), m.start()) for m in lane_re.finditer(text)]
positions.append(("__end__", len(text)))
for i in range(len(positions) - 1):
    lane, start = positions[i]
    end = positions[i+1][1]
    block = text[start:end]
    sig_match = re.search(r"bench_signal:\s*\|\s*\n(?P<body>(?:[ \t]+.*\n?)+?)(?=^[ \t]*pass_when:|^[ \t]*-\s*id:|\Z)", block, re.M)
    if not sig_match:
        continue
    body = sig_match.group("body")
    indent_match = re.match(r"^([ \t]+)", body)
    if indent_match:
        indent = indent_match.group(1)
        body = re.sub(r"(?m)^" + indent, "", body)
    out_path = os.path.join(run_dir, f"{lane}.sh")
    with open(out_path, "w") as f:
        f.write("#!/usr/bin/env bash\nset -u\ncd \"$1\"\n\n")
        f.write(body)
    os.chmod(out_path, 0o755)
PYEOF

# Run each lane's signal script and dump output. Append one JSONL row per lane.
while IFS=$'\t' read -r LANE AXIS DESC; do
  if [ -z "$LANE" ]; then continue; fi
  SIG_SCRIPT="$RUN_DIR/$LANE.sh"
  OUT_FILE="$RUN_DIR/$LANE.out"
  if [ ! -x "$SIG_SCRIPT" ]; then
    echo "[bench] $LANE: signal script missing, skipping" >&2
    continue
  fi
  echo "[bench] $LANE ($AXIS)" >&2
  START_MS=$(python3 -c 'import time;print(int(time.time()*1000))')
  bash "$SIG_SCRIPT" "$REPO_ROOT" >"$OUT_FILE" 2>&1
  EXIT_CODE=$?
  END_MS=$(python3 -c 'import time;print(int(time.time()*1000))')
  OUT_BYTES=$(wc -c < "$OUT_FILE" | tr -d ' ')
  python3 - "$LEDGER" "$RUN_ID" "$LANE" "$AXIS" "$DESC" "$OUT_FILE" "$EXIT_CODE" "$OUT_BYTES" "$START_MS" "$END_MS" <<'PYEOF'
import json, sys, time
ledger, run_id, lane, axis, desc, out_file, exit_code, out_bytes, start_ms, end_ms = sys.argv[1:]
row = {
  "ts": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
  "run_id": run_id,
  "lane": lane,
  "axis": axis,
  "description": desc,
  "out_file": out_file,
  "exit_code": int(exit_code),
  "out_bytes": int(out_bytes),
  "duration_ms": int(end_ms) - int(start_ms),
  "note": "evidence-only: no PASS/FAIL here; agent reads out_file and judges"
}
with open(ledger, "a") as f:
  f.write(json.dumps(row) + "\n")
PYEOF
done < "$TMP_LANES"

# Summary index for the agent
INDEX="$RUN_DIR/index.txt"
{
  echo "# Bench run $RUN_ID"
  echo "# evidence files (raw, agent-judged):"
  ls "$RUN_DIR"/*.out 2>/dev/null | sort
  echo
  echo "# ledger row appended to:"
  echo "$LEDGER"
} > "$INDEX"

echo "[bench] done run_id=$RUN_ID ledger=$LEDGER index=$INDEX" >&2
echo "$RUN_ID"
