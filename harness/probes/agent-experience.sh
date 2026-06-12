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
UNBROWSE_CMD="${UNBROWSE_HARNESS_BIN:-${UNBROWSE_BIN:-unbrowse}}"
RESOLVE_CMD="${UNBROWSE_HARNESS_RESOLVE_CMD:-read resolve}"
RUN_ID="$(date -u +%Y-%m-%dT%H-%M-%SZ)-$(head -c 4 /dev/urandom | od -An -tx1 | tr -d ' \n')"
OUT_DIR="${REPO}/harness/runs/${RUN_ID}"
MANAGED_BROWSER_PATTERN='kuri|headless=new|remote-debugging-port=9222|--user-data-dir=.*\.kuri'
KURI_PROCESS_PATTERN='packages/skill/vendor/kuri|/kuri([[:space:]]|$)'

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
echo "[harness] cli=${UNBROWSE_CMD}"
echo "[harness] resolve_cmd=${RESOLVE_CMD}"
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

  pkill -9 -f "$MANAGED_BROWSER_PATTERN" 2>/dev/null; sleep 1

  start_ms=$(python3 -c 'import time; print(int(time.time()*1000))')
  api_timeout_ms=$(( TIMEOUT * 1000 - 5000 ))
  [ "$api_timeout_ms" -lt 1000 ] && api_timeout_ms=1000
  read -r -a cli_parts <<< "$UNBROWSE_CMD"
  read -r -a resolve_parts <<< "$RESOLVE_CMD"
  UNBROWSE_RESOLVE_CACHE_TTL_MS=0 UNBROWSE_API_TIMEOUT_MS="$api_timeout_ms" timeout "$TIMEOUT" "${cli_parts[@]}" "${resolve_parts[@]}" --intent "$intent" --url "$url" >"$log" 2>&1
  rc=$?
  end_ms=$(python3 -c 'import time; print(int(time.time()*1000))')

  # Snapshot live processes BEFORE cleanup (load-bearing for screen-flood judgment)
  kuri_pids="$(pgrep -f "$KURI_PROCESS_PATTERN" 2>/dev/null | tr '\n' ' ')"
  visible_chrome="$(pgrep -af 'Chrome' 2>/dev/null | grep -v 'headless=new' | grep -v 'pgrep' | head -3)"

  pkill -9 -f "$MANAGED_BROWSER_PATTERN" 2>/dev/null

  python3 - "$intent" "$url" "$rc" "$log" "$start_ms" "$end_ms" "$kuri_pids" "$visible_chrome" "$artifact" <<'PY'
import sys, json, re, os
intent, url, rc_s, log_path, start_ms, end_ms, kuri_pids, visible_chrome, artifact = sys.argv[1:10]
rc = int(rc_s)
log = open(log_path, 'r', errors='replace').read()
# Find the last JSON object in the output (resolve response)
# Strict=False handles control chars in description fields.
parsed = None
# Fast path: CLI responses are usually the final single-line JSON object.
# Large auth interstitial logs can contain many braces; parse newest JSON-looking
# lines first so the harness does not spend minutes trimming HTML bodies.
for line in reversed(log.splitlines()):
    candidate = line.strip()
    if not (candidate.startswith("{") and candidate.endswith("}")):
        continue
    try:
        parsed = json.loads(candidate, strict=False)
        if isinstance(parsed, dict) and any(k in parsed for k in ('result','available_operations','available_endpoints','trace','source','error')):
            break
        parsed = None
    except Exception:
        parsed = None
if parsed is None:
    # Fallback: newest brace candidates only, capped to avoid pathological scans.
    candidate_starts = [m.start() for m in re.finditer(r'^\{', log, re.MULTILINE)]
    if not candidate_starts:
        candidate_starts = [m.start() for m in re.finditer(r'\{', log)][-50:]
    for start in reversed(candidate_starts):
        chunk = log[start:].rstrip()
        try:
            parsed = json.loads(chunk, strict=False)
            if isinstance(parsed, dict) and any(k in parsed for k in ('result','available_operations','available_endpoints','trace','source','error')):
                break
            parsed = None
        except Exception:
            parsed = None
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
    impact = parsed.get("impact") if isinstance(parsed.get("impact"), dict) else {}
    diag = r.get("diagnostic") or {}
    artifact_obj["source"] = (
        r.get("source")
        or parsed.get("source")
        or impact.get("source")
        or r.get("cache_source")
        or diag.get("cache_source")
    )
    artifact_obj["browser_avoided"] = (
        r.get("browser_avoided")
        if r.get("browser_avoided") is not None
        else impact.get("browser_avoided", diag.get("browser_avoided"))
    )
    artifact_obj["top_reasoning"] = diag.get("top_reasoning")
    artifact_obj["confidence"] = diag.get("confidence")
    artifact_obj["endpoint_count_in_skill"] = diag.get("endpoint_count")
    artifact_obj["error"] = r.get("error")
    artifact_obj["next_action"] = r.get("next_action")
    req = r.get("requirements")
    if isinstance(req, dict):
        artifact_obj["requirements"] = req
    artifact_obj["trace_success"] = (parsed.get("trace") or {}).get("success") if isinstance(parsed.get("trace"), dict) else None
    artifact_obj["result_shape"] = sorted([str(k) for k in r.keys()])[:30] if isinstance(r, dict) else []
    data = r.get("data") if isinstance(r, dict) else None
    artifact_obj["data_shape"] = sorted([str(k) for k in data.keys()])[:30] if isinstance(data, dict) else []
    excerpt = r.get("text_excerpt") or r.get("markdown") or ""
    if isinstance(excerpt, str) and excerpt:
        artifact_obj["content_excerpt"] = excerpt[:500]
    if isinstance(r.get("title"), str):
        artifact_obj["title"] = r.get("title")
    extraction = r.get("extraction") if isinstance(r.get("extraction"), dict) else {}
    artifact_obj["extraction_source"] = extraction.get("source")
    artifact_obj["extraction_rejected"] = r.get("rejected")
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
    "cli": os.environ.get("UNBROWSE_HARNESS_BIN") or os.environ.get("UNBROWSE_BIN") or "unbrowse",
    "resolve_cmd": os.environ.get("UNBROWSE_HARNESS_RESOLVE_CMD") or "read resolve",
    "probes": [json.load(open(a)) for a in artifacts],
}
open(f"{out_dir}/manifest.json", 'w').write(json.dumps(manifest, indent=2))
print(f"[harness] wrote manifest with {len(artifacts)} probes -> {out_dir}/manifest.json")
PY

echo
echo "[harness] DONE. Hand to agent for judgment:"
echo "  cat ${OUT_DIR}/manifest.json"
