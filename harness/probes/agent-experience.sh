#!/usr/bin/env bash
# agent-experience.sh — collects evidence, no assertions.
# Per CLAUDE.md "harness collects, agent judges": this script runs unbrowse
# against a corpus of (intent, url) pairs and writes one JSON artifact per
# probe to harness/runs/<run-id>/. The agent (in-thread or sub-agent) reads
# the artifacts and judges. No pass/fail logic in here.
#
# Usage:
#   bash harness/probes/agent-experience.sh                       # default corpus
#   bash harness/probes/agent-experience.sh --corpus FILE         # custom (one "intent|url" per line)
#   bash harness/probes/agent-experience.sh --timeout 60          # per-probe timeout seconds

set -uo pipefail

REPO="$(cd "$(dirname "$0")/../.." && pwd)"
CORPUS="${REPO}/harness/probes/corpus.txt"
TIMEOUT=60
RUN_ID="$(date -u +%Y-%m-%dT%H-%M-%SZ)-$(head -c 4 /dev/urandom | od -An -tx1 | tr -d ' \n')"
OUT_DIR="${REPO}/harness/runs/${RUN_ID}"

while [ $# -gt 0 ]; do
  case "$1" in
    --corpus)  CORPUS="$2"; shift 2 ;;
    --timeout) TIMEOUT="$2"; shift 2 ;;
    *) echo "unknown arg: $1" >&2; exit 2 ;;
  esac
done

mkdir -p "$OUT_DIR"
echo "[harness] run_id=$RUN_ID"
echo "[harness] corpus=$CORPUS"
echo "[harness] out=$OUT_DIR"
echo "[harness] timeout=${TIMEOUT}s per probe"
echo

i=0
while IFS= read -r line; do
  [ -z "$line" ] && continue
  case "$line" in \#*) continue ;; esac
  intent="${line%%|*}"
  url="${line#*|}"
  i=$((i+1))
  slot="$(printf "%03d" "$i")"
  artifact="${OUT_DIR}/${slot}.json"
  log="${OUT_DIR}/${slot}.log"

  pkill -9 -f 'kuri|chrome' 2>/dev/null; sleep 1

  start_ms=$(python3 -c 'import time; print(int(time.time()*1000))')
  timeout "$TIMEOUT" bun "$REPO/src/cli.ts" resolve --intent "$intent" --url "$url" >"$log" 2>&1
  rc=$?
  end_ms=$(python3 -c 'import time; print(int(time.time()*1000))')

  # Snapshot live processes BEFORE cleanup (load-bearing for screen-flood judgment)
  kuri_pids="$(pgrep -f 'kuri' 2>/dev/null | tr '\n' ' ')"
  visible_chrome="$(pgrep -af 'Chrome' 2>/dev/null | grep -v 'headless=new' | grep -v 'pgrep' | head -3)"

  pkill -9 -f 'kuri|chrome' 2>/dev/null

  python3 - "$intent" "$url" "$rc" "$log" "$start_ms" "$end_ms" "$kuri_pids" "$visible_chrome" "$artifact" <<'PY'
import sys, json, re, os
intent, url, rc_s, log_path, start_ms, end_ms, kuri_pids, visible_chrome, artifact = sys.argv[1:10]
rc = int(rc_s)
log = open(log_path, 'r', errors='replace').read()
# Find the last JSON object in the output (resolve response)
# Strict=False handles control chars in description fields.
parsed = None
# Find the resolve response: it's the last balanced top-level JSON object.
# CLI prints `[domain-cache] loaded N entries` lines first, then one big JSON.
# Strip leading non-JSON noise then attempt parse from the first '{' we find
# whose closing '}' completes the buffer.
candidate_starts = [m.start() for m in re.finditer(r'^\{', log, re.MULTILINE)]
if not candidate_starts:
    # Fallback: any '{' is a starting candidate, oldest-first
    candidate_starts = [m.start() for m in re.finditer(r'\{', log)]
for start in candidate_starts:
    chunk = log[start:].rstrip()
    # Walk back from end of buffer to find a balanced parse
    while chunk:
        try:
            parsed = json.loads(chunk, strict=False)
            # Want the object that has 'result' or 'available_operations' or 'trace'
            if isinstance(parsed, dict) and any(k in parsed for k in ('result','available_operations','available_endpoints','trace','source')):
                break
            parsed = None
        except Exception:
            pass
        # Trim trailing chars and try again — handles trailing whitespace/newlines
        last_brace = chunk.rfind('}')
        if last_brace <= 0:
            break
        chunk = chunk[:last_brace+1]
    if parsed:
        break
artifact_obj = {
    "intent": intent,
    "url": url,
    "exit_code": rc,
    "duration_ms": int(end_ms) - int(start_ms),
    "timed_out": rc == 124,
    "kuri_pids_alive_after_run": kuri_pids.strip().split() if kuri_pids.strip() else [],
    "visible_chrome_present": bool(visible_chrome.strip()),
    "log_path": log_path,
}
if parsed:
    r = parsed.get('result', parsed)
    diag = r.get("diagnostic") or {}
    artifact_obj["source"] = (
        r.get("source")
        or r.get("cache_source")
        or diag.get("cache_source")
    )
    artifact_obj["browser_avoided"] = r.get("browser_avoided") or diag.get("browser_avoided")
    artifact_obj["top_reasoning"] = diag.get("top_reasoning")
    artifact_obj["confidence"] = diag.get("confidence")
    artifact_obj["endpoint_count_in_skill"] = diag.get("endpoint_count")
    artifact_obj["error"] = r.get("error")
    ao = r.get("available_operations", [])
    ae = r.get("available_endpoints", [])
    artifact_obj["available_operations"] = [
        {
            "method": op.get("method", "GET"),
            "url_template": op.get("url_template") or op.get("url", ""),
            "endpoint_id": op.get("endpoint_id"),
            "description": (op.get("description_out") or op.get("description") or "")[:200],
        }
        for op in (ao if isinstance(ao, list) else [])[:5]
    ]
    artifact_obj["available_endpoints"] = [
        {
            "method": ep.get("method", "GET"),
            "url": (ep.get("url") or "")[:120],
            "score": ep.get("score"),
            "description": (ep.get("description") or "")[:200],
            "needs_params": ep.get("needs_params"),
        }
        for ep in (ae if isinstance(ae, list) else [])[:5]
    ]
    artifact_obj["suggested_next_operation_id"] = r.get("suggested_next_operation_id")
    artifact_obj["diagnostic"] = r.get("diagnostic")
else:
    artifact_obj["parse_error"] = True
    artifact_obj["log_tail"] = log[-1000:]
open(artifact, 'w').write(json.dumps(artifact_obj, indent=2))
print(f"[harness] {sys.argv[9].rsplit('/',1)[-1]}: rc={rc} dur={artifact_obj['duration_ms']}ms src={artifact_obj.get('source','?')} ops={len(artifact_obj.get('available_operations',[]))}", file=sys.stderr)
PY
done < "$CORPUS"

# Build a manifest the agent can read in one go
python3 - "$OUT_DIR" <<'PY'
import json, os, glob, sys
out_dir = sys.argv[1]
artifacts = sorted(glob.glob(f"{out_dir}/*.json"))
manifest = {
    "run_id": out_dir.rsplit('/',1)[-1],
    "probe_count": len(artifacts),
    "probes": [json.load(open(a)) for a in artifacts],
}
open(f"{out_dir}/manifest.json", 'w').write(json.dumps(manifest, indent=2))
print(f"[harness] wrote manifest with {len(artifacts)} probes -> {out_dir}/manifest.json")
PY

echo
echo "[harness] DONE. Hand to agent for judgment:"
echo "  cat ${OUT_DIR}/manifest.json"
