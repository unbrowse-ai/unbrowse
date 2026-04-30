#!/usr/bin/env bash
# metric-probe — emit one JSON row for a named metric, resolved by path.
#
# Usage:
#   metric-probe <endpoint>#<json.path>
#
# Examples:
#   metric-probe analytics.funnel#stages[1].users
#   metric-probe analytics.economics#estimated_monthly_revenue_run_rate_usd
#   metric-probe traction#githubStars
#   metric-probe stats.fees#total_charged_usd
#
# List every available metric path:
#   metric-probe --list   (or: bash scripts/metric-discover.sh)
#
# Output: { "metric": "...", "value": <number>, "unit": "...", "ts": "...", "source": "..." }
#
# Principle: never hand-curate metric names. Every numeric leaf the backend
# exposes is automatically probeable. When the backend adds a new field it
# becomes a probeable money metric with zero code change here.
set -uo pipefail

METRIC="${1:-}"
REPO_ROOT="$(git rev-parse --show-toplevel 2>/dev/null || pwd)"

if [ -z "$METRIC" ] || [ "$METRIC" = "--list" ]; then
  bash "$REPO_ROOT/scripts/metric-discover.sh"
  exit 0
fi

ADMIN="${UNBROWSE_ADMIN_KEY:-$(grep '^UNBROWSE_ADMIN_KEY' "$REPO_ROOT/.env" 2>/dev/null | sed 's/^[^=]*=//')}"
BASE="${UNBROWSE_API_URL:-https://beta-api.unbrowse.ai}"
LAUNCH="${UNBROWSE_LAUNCH_URL:-https://launch.unbrowse.ai}"

# Split endpoint and path on #
ENDPOINT="${METRIC%%#*}"
JPATH="${METRIC#*#}"
if [ "$ENDPOINT" = "$METRIC" ] || [ -z "$JPATH" ]; then
  echo "{\"error\":\"metric must be <endpoint>#<json.path> — run metric-probe --list to see all available paths\"}" >&2
  exit 2
fi

# Map endpoint names to URLs + auth
case "$ENDPOINT" in
  analytics.*)    URL="$BASE/v1/analytics/${ENDPOINT#analytics.}"; AUTH=admin ;;
  stats.summary)  URL="$BASE/v1/stats/summary"; AUTH=public ;;
  stats.*)        URL="$BASE/v1/stats/${ENDPOINT#stats.}"; AUTH=admin ;;
  credits.*)      URL="$BASE/v1/credits/${ENDPOINT#credits.}"; AUTH=admin ;;
  traction)       URL="$LAUNCH/api/traction"; AUTH=public ;;
  local.trace-join)
    # Local probe: scans ~/.unbrowse/traces/ and computes coverage of the
    # four-way join (intent × state × outcome × happiness). No backend
    # round-trip — this metric is the whole point of the intent-routing moat
    # harness and must be readable from a cold laptop with no network.
    #
    # TWO formats live in the same directory:
    #   (A) .jsonl files per-domain, written by src/graph/trace-store.ts (the
    #       RAG reader format — findTracesByIntent reads these). Fields:
    #       intent, endpoint_sequence, success, params.
    #   (B) .json files per-trace, written by src/telemetry.ts:emitRouteTrace.
    #       Fields: goal, session_scope, outcome, bindings_before, latency_ms,
    #       candidates_considered, failure_reason. This is the production
    #       write path, which the graph reader is blind to today.
    #
    # Both are counted. If rung 1.5 reconciles them into a single readable
    # format, the trace_join_coverage metric will jump because the rich (B)
    # rows already have 3/4 join axes populated (goal→intent, session_scope→
    # state, outcome→outcome; missing axis is still happiness_signal).
    TS=$(date -u +%FT%TZ)
    python3 - "$JPATH" "$TS" <<'PY'
import sys, json, os, glob
jpath, ts = sys.argv[1], sys.argv[2]
store = os.path.expanduser("~/.unbrowse/traces")
jsonl_files = sorted(glob.glob(os.path.join(store, "*.jsonl")))
json_files  = sorted(glob.glob(os.path.join(store, "*.json")))

total = 0
full = 0
per_field = {"intent": 0, "session_state_hash": 0, "outcome": 0, "happiness_signal": 0}
per_format = {"jsonl_graph_trace_store": 0, "json_telemetry_emitRouteTrace": 0}
domains = set()

def count_row(row, fmt):
    global total, full
    total += 1
    per_format[fmt] += 1
    domains.add(row.get("domain",""))
    # Map both formats to the four join axes.
    intent = row.get("intent") or row.get("goal")
    state  = row.get("session_state_hash") or row.get("session_scope")
    outcome = row.get("outcome") or ("success" in row)
    happy  = row.get("happiness_signal")
    if intent:   per_field["intent"] += 1
    if state:    per_field["session_state_hash"] += 1
    if outcome:  per_field["outcome"] += 1
    if happy:    per_field["happiness_signal"] += 1
    if intent and state and outcome and happy:
        full += 1

for f in jsonl_files:
    try:
        for line in open(f):
            line = line.strip()
            if not line: continue
            try: row = json.loads(line)
            except: continue
            count_row(row, "jsonl_graph_trace_store")
    except FileNotFoundError:
        pass

for f in json_files:
    try:
        with open(f) as fh:
            row = json.load(fh)
        count_row(row, "json_telemetry_emitRouteTrace")
    except Exception:
        pass

coverage = (full / total) if total else 0.0
three_of_four = sum(1 for v in [per_field["intent"], per_field["session_state_hash"],
                                 per_field["outcome"]] if v == total)
out = {
    "metric": f"local.trace-join#{jpath}",
    "value": coverage if jpath == "coverage" else per_field.get(jpath, total if jpath == "total_traces" else 0),
    "unit": "ratio" if jpath == "coverage" else "count",
    "ts": ts,
    "source": store,
    "breakdown": {
        "total_traces": total,
        "full_four_way": full,
        "per_field_populated": per_field,
        "per_format": per_format,
        "three_axes_populated_need_happiness": per_field["intent"] and per_field["session_state_hash"] and per_field["outcome"],
        "domain_count": len(domains),
        "files_scanned_jsonl": len(jsonl_files),
        "files_scanned_json": len(json_files),
    }
}
print(json.dumps(out))
PY
    exit 0
    ;;
  *)              echo "{\"error\":\"unknown endpoint: $ENDPOINT\"}" >&2; exit 3 ;;
esac

BODY_FILE=$(mktemp)
trap 'rm -f "$BODY_FILE"' EXIT
if [ "$AUTH" = "admin" ]; then
  curl -sS --max-time 10 -H "Authorization: Bearer $ADMIN" "$URL" -o "$BODY_FILE"
else
  curl -sS --max-time 10 "$URL" -o "$BODY_FILE"
fi

TS=$(date -u +%FT%TZ)
python3 - "$ENDPOINT" "$JPATH" "$URL" "$TS" "$BODY_FILE" <<'PY'
import sys, json, re
endpoint, jpath, source, ts, body_file = sys.argv[1:6]
body = json.load(open(body_file))

def resolve(obj, path):
    # path looks like "stages[1].users" or "perf.avg_resolve_ms"
    tokens = re.findall(r'[^.\[\]]+|\[\d+\]', path)
    for tok in tokens:
        if tok.startswith('['):
            idx = int(tok[1:-1])
            obj = obj[idx]
        else:
            obj = obj[tok]
    return obj

try:
    value = resolve(body, jpath)
except Exception as e:
    print(json.dumps({"error": f"path resolve failed: {e}", "endpoint": endpoint, "path": jpath}))
    sys.exit(4)

if not isinstance(value, (int, float)) or isinstance(value, bool):
    print(json.dumps({"error": "not a numeric leaf", "endpoint": endpoint, "path": jpath, "got": str(type(value).__name__)}))
    sys.exit(5)

def unit_hint(p, v):
    p = p.lower()
    if any(k in p for k in ["_usd","cost","price","revenue","ltv","saved_usd"]): return "usd"
    if any(k in p for k in ["rate","ratio","_pc"]) and v <= 1.0: return "ratio"
    if any(k in p for k in ["_pct"]): return "pct"
    if any(k in p for k in ["_ms","latency","duration"]): return "ms"
    if "_uc" in p: return "uc"
    if "tokens" in p: return "tokens"
    return "count"

print(json.dumps({
    "metric": f"{endpoint}#{jpath}",
    "value": value,
    "unit": unit_hint(jpath, value),
    "ts": ts,
    "source": source
}))
PY
