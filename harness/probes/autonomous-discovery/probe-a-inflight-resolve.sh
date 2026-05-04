#!/usr/bin/env bash
# Probe A — in-flight resolve.
#
# Drives `unbrowse go` against jmail.world, lets the interceptor accumulate
# for 5s, then runs `unbrowse resolve` against the same URL WITHOUT closing
# or syncing. Captures buffer state, resolve output, and timings.
#
# No assertions — see JUDGE.md for verdict criteria.

set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
# shellcheck disable=SC1091
source "${SCRIPT_DIR}/lib.sh"

INTENT="${1:-search emails for dog food}"
URL="${2:-https://jmail.world/search?q=dog+food}"
DOMAIN="$(python3 -c 'import sys,urllib.parse as u; print(u.urlparse(sys.argv[1]).netloc)' "$URL")"

ARTIFACT="${OUT_DIR}/probe-a.json"
LOG="${OUT_DIR}/probe-a.log"
RESOLVE_RAW="${OUT_DIR}/probe-a.resolve.json"
BUFFER_DUMP="${OUT_DIR}/probe-a.buffer.json"
GO_LOG="${OUT_DIR}/probe-a.go.log"

ensure_server || { echo '{"error":"server_not_up"}' >"$ARTIFACT"; exit 0; }

# Clean state: kill stale browsers (don't kill the unbrowse server!)
pkill -9 -f 'kuri' 2>/dev/null || true
sleep 1

t_start=$(now_ms)

echo "[probe-a] go $URL" >&2
$UNBROWSE_BIN go "$URL" >"$GO_LOG" 2>&1
go_rc=$?
t_go=$(now_ms)

# Get the active session id for this domain
SESSION_ID="$(latest_session_for_domain "$DOMAIN")"

echo "[probe-a] sleep 15s while interceptor accumulates (gives Fix B watcher 1+ tick)" >&2
sleep 15

t_pre_resolve=$(now_ms)

echo "[probe-a] resolve --intent '$INTENT' --url '$URL' (NO close, NO sync)" >&2
t_resolve_start=$(now_ms)
$UNBROWSE_BIN resolve --intent "$INTENT" --url "$URL" --pretty >"$LOG" 2>&1
resolve_rc=$?
t_resolve_end=$(now_ms)

# Extract the resolve JSON
extract_last_json "$LOG" >"$RESOLVE_RAW"

# Snapshot the buffer AFTER resolve so the destructive HAR stop+restart
# inside the admin endpoint doesn't drain the buffer Fix A wants to flush.
session_buffer_snapshot "$SESSION_ID" "$BUFFER_DUMP"

buffer_size="$(python3 -c '
import json,sys
try:
    d=json.load(open(sys.argv[1]))
except Exception:
    print(0); sys.exit(0)
if d.get("error"):
    print(-1); sys.exit(0)
total = d.get("total_captured")
if total is not None:
    print(total); sys.exit(0)
reqs=d.get("intercepted_requests") or d.get("requests") or []
print(len(reqs))
' "$BUFFER_DUMP")"

t_buffer_snap=$(now_ms)
extract_last_json "$LOG" >"$RESOLVE_RAW"

# Process snapshot before cleanup (load-bearing: tells us if a browser opened)
kuri_pids="$(pgrep -f 'kuri' 2>/dev/null | tr '\n' ' ')"
visible_chrome="$(pgrep -af 'Google Chrome' 2>/dev/null | grep -v 'headless=new' | head -3 | tr '\n' ';')"

# Build artifact
python3 - \
  "$ARTIFACT" "$RESOLVE_RAW" "$BUFFER_DUMP" \
  "$INTENT" "$URL" "$DOMAIN" "$SESSION_ID" \
  "$t_start" "$t_go" "$t_buffer_snap" "$t_resolve_start" "$t_resolve_end" \
  "$go_rc" "$resolve_rc" "$buffer_size" \
  "$kuri_pids" "$visible_chrome" \
<<'PY'
import sys, json
(artifact_path, resolve_raw_path, buffer_dump_path,
 intent, url, domain, session_id,
 t_start, t_go, t_buffer_snap, t_resolve_start, t_resolve_end,
 go_rc, resolve_rc, buffer_size,
 kuri_pids, visible_chrome) = sys.argv[1:18]
def loadj(p):
    try: return json.load(open(p))
    except Exception: return {}
resolve = loadj(resolve_raw_path)
def first(d, *keys):
    for k in keys:
        if isinstance(d, dict) and k in d and d[k] is not None:
            return d[k]
    return None
# resolve fields are nested under "result" or surfaced top-level for compat
inner = resolve.get("result") if isinstance(resolve.get("result"), dict) else {}
ops = first(resolve, "available_operations", "operations") or first(inner, "available_operations", "operations") or []
endpoints = first(resolve, "available_endpoints", "endpoints") or first(inner, "available_endpoints", "endpoints") or []
top_op = ops[0] if ops else None
inflight_flush = resolve.get("inflight_flush") or inner.get("inflight_flush")
    "probe": "A — in-flight resolve",
    "intent": intent,
    "url": url,
    "domain": domain,
    "session_id": session_id,
    "go_exit_code": int(go_rc),
    "resolve_exit_code": int(resolve_rc),
    "t_start_ms": int(t_start),
    "t_go_ms": int(t_go) - int(t_start),
    "t_buffer_snapshot_ms": int(t_buffer_snap) - int(t_start),
    "t_buffer_size_pre_resolve": int(buffer_size),
    "t_resolve_ms": int(t_resolve_end) - int(t_resolve_start),
    "resolve": {
        "source": first(resolve, "source"),
        "has_available_operations": bool(ops),
        "n_operations": len(ops),
        "n_endpoints": len(endpoints),
        "top_op": (
            {"operation_id": first(top_op, "operation_id", "id"),
             "description": first(top_op, "description", "summary")}
            if top_op else None
        "inflight_flush": inflight_flush,
        "cache_hit": resolve.get("timing", {}).get("cache_hit") if isinstance(resolve.get("timing"), dict) else None,
    },
    },
    "kuri_pids_after_resolve": kuri_pids.split() if kuri_pids.strip() else [],
    "visible_chrome_after_resolve": [s for s in visible_chrome.split(";") if s.strip()],
    "resolve_raw_path": resolve_raw_path,
    "buffer_dump_path": buffer_dump_path,
    "log_path": artifact_path.replace(".json", ".log"),
}
open(artifact_path,"w").write(json.dumps(artifact, indent=2))
PY

append_to_manifest "probe-a-inflight-resolve" "$ARTIFACT"

# Best-effort cleanup: close session, then kill browser
$UNBROWSE_BIN close >/dev/null 2>&1 || true
pkill -9 -f 'kuri' 2>/dev/null || true

echo "[probe-a] artifact: $ARTIFACT" >&2
exit 0
