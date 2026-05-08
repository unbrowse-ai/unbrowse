#!/usr/bin/env bash
# bench-two-phase.sh — measure RE+index (Phase 1) and call-directly (Phase 2)
# as separate verdicts.
#
# Per URL:
#   1. Wipe ~/.unbrowse/{skills,skill-cache,traces}   (anti-cheat)
#   2. Phase 1: `unbrowse capture --url --intent`     (publish skill)
#   3. Phase 2: `unbrowse execute --skill ID --endpoint ID`  (call cold from skill)
#   4. Record both phase outcomes + a combined verdict
#
# Wipe runs ONCE per URL (before Phase 1), NEVER between phases — Phase 2
# needs the skill Phase 1 just published.
#
# Profiles + vault are NEVER wiped (real auth ≠ cheating).
#
# Usage:
#   bash scripts/bench-two-phase.sh                              # full hard-target corpus
#   bash scripts/bench-two-phase.sh --corpus F                   # override
#   bash scripts/bench-two-phase.sh --only-url URL               # one URL only
#   bash scripts/bench-two-phase.sh --use-source                 # bun src/cli.ts
#   bash scripts/bench-two-phase.sh --timeout 90                 # per-phase timeout
#   bash scripts/bench-two-phase.sh --note "iter X"
set -uo pipefail

export PATH="$HOME/.npm-global/bin:/opt/nanobrew/prefix/bin:/usr/local/bin:/opt/homebrew/bin:$PATH"

CORPUS="scripts/corpus/hard-target-bench.txt"
TIMEOUT=90
CLI_CMD="unbrowse"
ONLY_URL=""
NOTE=""

while [ $# -gt 0 ]; do
  case "$1" in
    --corpus) CORPUS="$2"; shift 2 ;;
    --timeout) TIMEOUT="$2"; shift 2 ;;
    --use-source) CLI_CMD="bun src/cli.ts"; shift ;;
    --only-url) ONLY_URL="$2"; shift 2 ;;
    --note) NOTE="$2"; shift 2 ;;
    *) echo "unknown arg: $1" >&2; exit 2 ;;
  esac
done

[ -f "$CORPUS" ] || { echo "[two-phase] corpus not found: $CORPUS" >&2; exit 1; }

RUN_ID="$(date -u +%Y%m%dT%H%M%SZ)"
RUN_DIR=".bench-history/$RUN_ID"
mkdir -p "$RUN_DIR"
HISTORY_JSONL=".bench-history/runs.jsonl"
touch "$HISTORY_JSONL"

wipe_marketplace() {
  pkill -9 -f 'unbrowse|kuri' 2>/dev/null || true
  sleep 0.3
  rm -rf "$HOME/.unbrowse/skills"/*       2>/dev/null || true
  rm -rf "$HOME/.unbrowse/skill-cache"/*  2>/dev/null || true
  rm -rf "$HOME/.unbrowse/traces"/*       2>/dev/null || true
}

# Per-row classifier: extracts both phases' outcomes from raw stdout dumps.
# Honest about parse errors — never fabricates a status.
cat > "$RUN_DIR/extract.py" <<'PY'
import sys, json, re, os

# Args: capture_out_path, execute_out_path|"", goal, url, capture_exit, execute_exit|""
capture_path = sys.argv[1]
execute_path = sys.argv[2]
goal         = sys.argv[3]
url          = sys.argv[4]
capture_exit = int(sys.argv[5])
execute_exit = int(sys.argv[6]) if sys.argv[6] else None
# Bash-extracted skill_id + endpoint_id (from `unbrowse skill <id>`).
# Override the values parsed from capture stdout when these are non-empty.
override_skill    = sys.argv[7] if len(sys.argv) > 7 else ""
override_endpoint = sys.argv[8] if len(sys.argv) > 8 else ""
def first_json_object(raw: str):
    """Find the FIRST top-level '{' object in raw and try to JSON-decode.
    `unbrowse capture` prefixes log lines with timestamps + [tag] markers;
    the JSON usually starts on its own line at the bottom."""
    for m in re.finditer(r'\{', raw):
        try:
            obj, _ = json.JSONDecoder(strict=False).raw_decode(raw[m.start():])
            if isinstance(obj, dict):
                return obj
        except Exception:
            continue
    return None

# ---- Phase 1: capture ----
phase1 = {
    "phase1_status": "unknown",
    "phase1_skill_id": "",
    "phase1_endpoint_id": "",
    "phase1_endpoints_discovered": 0,
    "phase1_capture_pattern": "",
    "phase1_browser_block_signals": "",
    "phase1_filter_rejections": "",
    "phase1_text_bytes": "",
    "phase1_observed_api_calls": "",
    "phase1_evidence": "",
}

if capture_exit == 124:
    phase1["phase1_status"] = "capture_timeout"
elif capture_exit != 0:
    phase1["phase1_status"] = "capture_error"
    phase1["phase1_evidence"] = f"exit={capture_exit}"

raw = open(capture_path).read() if os.path.exists(capture_path) else ""
obj = first_json_object(raw)
if obj is None:
    if phase1["phase1_status"] == "unknown":
        phase1["phase1_status"] = "capture_parse_error"
else:
    phase1["phase1_skill_id"] = str(obj.get("skill_id") or "")
    phase1["phase1_endpoints_discovered"] = int(obj.get("endpoints_discovered") or 0)
    phase1["phase1_capture_pattern"] = str(obj.get("capture_pattern") or "")
    note = obj.get("note_evidence") or {}
    eps  = note.get("endpoints") or []
    if eps and isinstance(eps[0], dict):
        phase1["phase1_endpoint_id"] = str(eps[0].get("endpoint_id") or "")

# Bash-extracted overrides take precedence (they read the published skill JSON,
# which has the canonical endpoint_id; capture stdout's note_evidence often
# omits it).
if override_skill:    phase1["phase1_skill_id"]    = override_skill
if override_endpoint: phase1["phase1_endpoint_id"] = override_endpoint

if obj is not None:
    meta = obj.get("captured_meta") or {}
    phase1["phase1_browser_block_signals"] = json.dumps(meta.get("browser_block_signals") or [])
    phase1["phase1_filter_rejections"]     = json.dumps(meta.get("filter_rejections") or {})
    phase1["phase1_text_bytes"]            = str(meta.get("text_bytes", ""))
    phase1["phase1_observed_api_calls"]    = str(meta.get("observed_api_calls", ""))

    # Derive phase1_status from evidence
    if phase1["phase1_status"] == "unknown":
        bs = phase1["phase1_browser_block_signals"]
        REAL_VENDORS = ("vendor:cloudflare","vendor:perimeterx","vendor:datadome",
                        "vendor:akamai_bot_manager","vendor:imperva_incapsula",
                        "vendor:shape_security","vendor:kasada")
        has_real_vendor = bs and any(v in bs for v in REAL_VENDORS)
        try: tb = int(phase1["phase1_text_bytes"] or 0)
        except: tb = 0
        if has_real_vendor:
            phase1["phase1_status"] = "vendor_blocked"
        elif tb < 100 and "sparse_capture_mostly_noise" in bs:
            phase1["phase1_status"] = "soft_block"
        elif phase1["phase1_endpoints_discovered"] == 0:
            phase1["phase1_status"] = "no_endpoints"
        elif phase1["phase1_capture_pattern"] == "doc_only":
            phase1["phase1_status"] = "indexed_doc_only"
        else:
            phase1["phase1_status"] = "indexed"

# ---- Phase 2: execute (EVIDENCE ONLY — no heuristic verdicts) ----
# Per CLAUDE.md "harness collects, agent judges": we collect raw evidence
# fields. We do NOT decide whether the call "succeeded" — status_code 200
# can be a captcha page, an empty array, or the wrong shape entirely. The
# agent reads phase2_response_excerpt in-thread and judges.
phase2 = {
    "phase2_ran": False,
    "phase2_exit": execute_exit if execute_exit is not None else "",
    "phase2_status_code": "",
    "phase2_error": "",
    "phase2_trace_success": "",          # raw value from trace.success — agent decides if it's truthful
    "phase2_response_bytes": 0,
    "phase2_response_excerpt": "",       # first ~2KB of the response body — agent reads + judges
    "phase2_result_shape": "",           # cheap shape signal (array/object/string/empty/error)
    "phase2_raw_excerpt": "",            # first 200 chars of raw stdout — for parse-error diagnosis
}

if execute_path and phase1["phase1_skill_id"] and phase1["phase1_endpoint_id"]:
    phase2["phase2_ran"] = True
    raw2 = open(execute_path).read() if os.path.exists(execute_path) else ""
    phase2["phase2_raw_excerpt"] = raw2[:200]
    obj2 = first_json_object(raw2)
    if obj2 is not None:
        trace = obj2.get("trace") or {}
        result_field = obj2.get("result")
        sc  = trace.get("status_code")
        err = trace.get("error") or ""
        phase2["phase2_status_code"]   = str(sc) if sc is not None else ""
        phase2["phase2_error"]         = err[:300]
        phase2["phase2_trace_success"] = "" if trace.get("success") is None else str(trace.get("success"))
        # Capture full response body for in-thread agent judgment.
        body_str = json.dumps(result_field, ensure_ascii=False) if result_field is not None else ""
        phase2["phase2_response_bytes"]   = len(body_str)
        phase2["phase2_response_excerpt"] = body_str[:2000]
        if isinstance(result_field, list):
            phase2["phase2_result_shape"] = f"array[{len(result_field)}]"
        elif isinstance(result_field, dict):
            keys = list(result_field.keys())[:8]
            phase2["phase2_result_shape"] = f"object{{{', '.join(keys)}}}"
        elif isinstance(result_field, str):
            phase2["phase2_result_shape"] = f"string[{len(result_field)}]"
        elif result_field is None:
            phase2["phase2_result_shape"] = "null"
        else:
            phase2["phase2_result_shape"] = type(result_field).__name__

# ---- Triage SORT KEY (not a verdict) ----
# This is a coarse bucket the agent uses to ORDER which rows to inspect first.
# It is NOT the answer to "did the call succeed". Agent must open the
# phase2_response_excerpt and judge against the intent.
def triage_bucket(p1s, ph2):
    if p1s in ("vendor_blocked",):
        return "z_likely_vendor_blocked"
    if p1s == "soft_block":
        return "z_likely_soft_block"
    if p1s in ("capture_timeout","capture_error","capture_parse_error","no_endpoints"):
        return "y_capture_didnt_yield_endpoint"
    if not ph2["phase2_ran"]:
        return "y_phase2_skipped"
    if ph2["phase2_response_bytes"] > 0:
        return "a_inspect_response_body"
    if ph2["phase2_status_code"]:
        return "b_inspect_status_code"
    return "c_inspect_raw"

row = {
    "goal": goal, "url": url,
    **phase1, **phase2,
    "triage_bucket": triage_bucket(phase1["phase1_status"], phase2),
    "capture_exit": capture_exit,
}
# verdict deliberately absent — agent judges in-thread by reading
# phase2_response_excerpt against `goal`. See AGENTS.md / CLAUDE.md
# "Bench verdicts: harness collects, agent judges".
print(json.dumps(row))
PY


i=0
results_file="$RUN_DIR/results.jsonl"
> "$results_file"
echo "[two-phase] run=$RUN_ID corpus=$CORPUS timeout=${TIMEOUT}s only=${ONLY_URL:-<all>}" >&2

while IFS='|' read -r goal url; do
  goal="${goal## }"; goal="${goal%% }"
  url="${url## }"; url="${url%% }"
  case "$goal" in ''|\#*) continue ;; esac
  [ -z "$url" ] && continue
  if [ -n "$ONLY_URL" ] && [ "$url" != "$ONLY_URL" ]; then continue; fi
  i=$((i+1))

  wipe_marketplace
  slug=$(printf '%s' "$url" | tr '/:?&=.' '_')
  cap_out="$RUN_DIR/${i}_${slug:0:50}_capture.out"
  exe_out="$RUN_DIR/${i}_${slug:0:50}_execute.out"
  echo "[two-phase] ($i) $url" >&2

  # Phase 1
  echo "  P1 capture..." >&2
  # shellcheck disable=SC2086
  timeout "$TIMEOUT" $CLI_CMD capture --url "$url" --intent "$goal" </dev/null > "$cap_out" 2>&1
  cap_exit=$?

  # Extract skill_id from capture output (best-effort; classifier handles failures).
  # Then query `unbrowse skill <id>` to read the actual endpoint_id from the
  # published skill JSON — note_evidence.endpoints rarely carries it.
  p1_skill=$(python3 -c "
import json, re, sys, os
raw = open('$cap_out').read() if os.path.exists('$cap_out') else ''
for m in re.finditer(r'\{', raw):
    try:
        d, _ = json.JSONDecoder(strict=False).raw_decode(raw[m.start():])
        if isinstance(d, dict) and d.get('skill_id'):
            print(d['skill_id']); sys.exit(0)
    except Exception: continue
print('')")

  # Use `unbrowse explain --top N` — the canonical harness-collects-agent-judges
  # primitive. Returns `shortlist_for_judgment` (top-N candidates + evidence)
  # and `judgment_question` for the agent to read in-thread. The agent picks
  # which endpoint to execute, not the heuristic ranker.
  #
  # Bench captures the FULL shortlist into the row (phase1_shortlist) so the
  # agent can see all candidates, not just the ranker's top-1 pick.
  p1_shortlist_json="[]"
  p1_endpoint=""
  if [ -n "$p1_skill" ]; then
    explain_out=$(timeout 30 $CLI_CMD explain --intent "$goal" --url "$url" --top 5 2>/dev/null || true)
    p1_shortlist_json=$(printf '%s' "$explain_out" | python3 -c "
import json, sys, re
raw = sys.stdin.read()
for m in re.finditer(r'\{', raw):
    try:
        d, _ = json.JSONDecoder(strict=False).raw_decode(raw[m.start():])
        if isinstance(d, dict) and ('shortlist_for_judgment' in d or 'agent_facing_shortlist' in d):
            sl = d.get('shortlist_for_judgment') or d.get('agent_facing_shortlist') or []
            print(json.dumps(sl))
            sys.exit(0)
    except Exception: continue
print('[]')")
    # Default execute target: shortlist[0] (ranker's top pick) — but the row
    # carries the full shortlist so the agent can override in judgment.
    p1_endpoint=$(printf '%s' "$p1_shortlist_json" | python3 -c "
import json, sys
sl = json.loads(sys.stdin.read())
if sl and isinstance(sl[0], dict):
    print(sl[0].get('endpoint_id') or '')
else:
    print('')")
  fi
  exe_exit=""
  if [ -n "$p1_skill" ] && [ -n "$p1_endpoint" ]; then
    echo "  P2 execute skill=$p1_skill ep=$p1_endpoint" >&2
    # shellcheck disable=SC2086
    timeout "$TIMEOUT" $CLI_CMD execute --skill "$p1_skill" --endpoint "$p1_endpoint" </dev/null > "$exe_out" 2>&1
    exe_exit=$?
  else
    echo "  P2 skipped (skill=${p1_skill:-<none>} ep=${p1_endpoint:-<none>})" >&2
    : > "$exe_out"
  fi

  ts="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
  record=$(python3 "$RUN_DIR/extract.py" "$cap_out" "$exe_out" "$goal" "$url" "$cap_exit" "${exe_exit:-}" "$p1_skill" "$p1_endpoint")
  # Inject (1) full shortlist from explain (harness-collects-agent-judges
  # surface) (2) run_id/ts/note. Single python step.
  enriched=$(printf '%s' "$record" | RUN_ID="$RUN_ID" TS="$ts" NOTE="$NOTE" SHORTLIST="$p1_shortlist_json" python3 -c "
import sys, json, os
row = json.loads(sys.stdin.read())
try:
    row['phase1_shortlist'] = json.loads(os.environ.get('SHORTLIST', '[]'))
except Exception:
    row['phase1_shortlist'] = []
row['run_id'] = os.environ.get('RUN_ID', '')
row['ts'] = os.environ.get('TS', '')
row['note'] = os.environ.get('NOTE', '')
print(json.dumps(row))
")
  echo "$enriched" >> "$results_file"
  echo "$enriched" >> "$HISTORY_JSONL"

  printf '%s' "$enriched" | python3 -c "
import sys, json
d = json.loads(sys.stdin.read())
parts = [d.get('triage_bucket','?'),
         f\"P1={d['phase1_status']}\"]
if d['phase1_endpoints_discovered']: parts.append(f\"eps={d['phase1_endpoints_discovered']}\")
if d.get('phase2_ran'): parts.append(f\"P2_ran sc={d.get('phase2_status_code','?')} bytes={d.get('phase2_response_bytes',0)}\")
shape = d.get('phase2_result_shape','')
if shape: parts.append(f\"shape={shape[:40]}\")
err = d.get('phase2_error','')
if err: parts.append(f\"err={err[:60]}\")
print('  ' + ' | '.join(parts), file=sys.stderr)
"
done < "$CORPUS"

echo "[two-phase] wrote $i rows to $results_file" >&2

# Per CLAUDE.md "harness collects, agent judges": no heuristic verdict tally.
# Print a triage_bucket histogram so the agent knows row counts and can pick
# inspection order. The actual verdict for each row comes from the agent
# reading phase2_response_excerpt against `goal` in-thread.
python3 - "$results_file" "$RUN_DIR/summary.json" <<'PY'
import sys, json, collections
rows = [json.loads(l) for l in open(sys.argv[1]) if l.strip()]
buckets = collections.Counter(r.get('triage_bucket') or '?' for r in rows)
phase1_indexed = sum(1 for r in rows if r.get('phase1_skill_id') and r.get('phase1_endpoint_id'))
phase2_ran     = sum(1 for r in rows if r.get('phase2_ran'))
summary = {
    'total': len(rows),
    'phase1_published_a_skill_with_endpoint': phase1_indexed,
    'phase2_actually_called': phase2_ran,
    'triage_buckets': dict(buckets),
    'note': 'Verdict per URL is agent-judged in-thread by reading phase2_response_excerpt against goal.',
}
open(sys.argv[2], 'w').write(json.dumps(summary, indent=2))
print('\n[two-phase] triage histogram (NOT a verdict — agent judges in-thread):', file=sys.stderr)
for k, v in sorted(buckets.items()):
    print(f'  {k:<35} {v}', file=sys.stderr)
print(f'  phase1 published a skill+endpoint: {phase1_indexed}/{len(rows)}', file=sys.stderr)
print(f'  phase2 actually called execute:    {phase2_ran}/{len(rows)}', file=sys.stderr)
PY

echo "[two-phase] done. run dir: $RUN_DIR" >&2
