#!/usr/bin/env bash
# Probe C — auto-CDP-attach.
#
# Launches a real Chrome with --remote-debugging-port=9222 BEFORE invoking
# unbrowse. Drives a navigation through the external Chrome via raw CDP
# (simulates chrome-devtools MCP). Then runs `unbrowse resolve` and checks
# whether unbrowse attached to the existing Chrome (PASS) or launched its
# own Kuri (FAIL).
#
# No assertions — see JUDGE.md.

set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
# shellcheck disable=SC1091
source "${SCRIPT_DIR}/lib.sh"

INTENT="${1:-search emails for dog food}"
URL="${2:-https://jmail.world/search?q=dog+food}"
DOMAIN="$(python3 -c 'import sys,urllib.parse as u; print(u.urlparse(sys.argv[1]).netloc)' "$URL")"
DEBUG_PORT="${CDP_DEBUG_PORT:-9222}"

ARTIFACT="${OUT_DIR}/probe-c.json"
LOG="${OUT_DIR}/probe-c.log"
RESOLVE_RAW="${OUT_DIR}/probe-c.resolve.json"
SESSION_DUMP="${OUT_DIR}/probe-c.session.json"
CDP_USER_DATA="${OUT_DIR}/chrome-user-data"

ensure_server || { echo '{"error":"server_not_up"}' >"$ARTIFACT"; exit 0; }

# Find Chrome binary
CHROME_BIN=""
for c in \
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" \
  "/Applications/Chromium.app/Contents/MacOS/Chromium" \
  "$(command -v google-chrome 2>/dev/null)" \
  "$(command -v chromium 2>/dev/null)"; do
  if [ -n "$c" ] && [ -x "$c" ]; then CHROME_BIN="$c"; break; fi
done
if [ -z "$CHROME_BIN" ]; then
  echo '{"error":"chrome_binary_not_found"}' >"$ARTIFACT"
  append_to_manifest "probe-c-cdp-attach" "$ARTIFACT"
  exit 0
fi

# Cleanup any stale state
pkill -9 -f 'kuri' 2>/dev/null || true
# Don't kill all chrome — only ones using our user-data-dir
mkdir -p "$CDP_USER_DATA"
sleep 1

# Snapshot kuri pids BEFORE
kuri_pids_before="$(pgrep -f 'kuri' 2>/dev/null | tr '\n' ' ')"

t_start=$(now_ms)

echo "[probe-c] launching external Chrome on port $DEBUG_PORT" >&2
"$CHROME_BIN" \
  --remote-debugging-port="$DEBUG_PORT" \
  --user-data-dir="$CDP_USER_DATA" \
  --headless=new \
  --no-first-run \
  --no-default-browser-check \
  about:blank \
  >"${OUT_DIR}/probe-c.chrome.log" 2>&1 &
EXTERNAL_CHROME_PID=$!

# Wait for CDP to be ready
for i in $(seq 1 20); do
  if curl -fsS -m 2 "http://localhost:${DEBUG_PORT}/json/version" >/dev/null 2>&1; then
    echo "[probe-c] Chrome CDP ready (pid=$EXTERNAL_CHROME_PID, port=$DEBUG_PORT)" >&2
    break
  fi
  sleep 0.5
done

t_chrome_ready=$(now_ms)

# Drive navigation via raw CDP — simulates what chrome-devtools MCP would do
# Use Page.navigate via the first target's WebSocket. Actually, simpler: hit
# the new-tab endpoint with a target URL.
TAB_URL="$(curl -fsS -m 5 "http://localhost:${DEBUG_PORT}/json/new?$(python3 -c 'import sys,urllib.parse as u;print(u.quote(sys.argv[1],safe=""))' "$URL")" 2>/dev/null \
  | python3 -c 'import sys,json; d=json.load(sys.stdin); print(d.get("url") or "")')"
t_external_navigated=$(now_ms)
echo "[probe-c] external Chrome navigated to $URL (tab url: $TAB_URL)" >&2

# Give external Chrome a moment to load (and ideally have unbrowse pick up traffic)
sleep 5

# Now invoke unbrowse — does it attach or launch a new Kuri?
echo "[probe-c] resolve --intent '$INTENT' --url '$URL'" >&2
t_resolve_start=$(now_ms)
$UNBROWSE_BIN resolve --intent "$INTENT" --url "$URL" --pretty >"$LOG" 2>&1
resolve_rc=$?
t_resolve_end=$(now_ms)

extract_last_json "$LOG" >"$RESOLVE_RAW"

# Snapshot kuri AFTER — if unchanged, unbrowse didn't launch its own Kuri (PASS)
kuri_pids_after="$(pgrep -f 'kuri' 2>/dev/null | tr '\n' ' ')"

# If admin sessions endpoint exists, snapshot the active session(s)
curl -fsS -m 5 "${UNBROWSE_API_BASE}/v1/admin/sessions" -o "$SESSION_DUMP" 2>/dev/null \
  || echo '{"error":"admin_sessions_endpoint_unavailable"}' >"$SESSION_DUMP"

python3 - \
  "$ARTIFACT" "$RESOLVE_RAW" "$SESSION_DUMP" \
  "$INTENT" "$URL" "$DOMAIN" \
  "$EXTERNAL_CHROME_PID" "$DEBUG_PORT" \
  "$kuri_pids_before" "$kuri_pids_after" \
  "$t_start" "$t_chrome_ready" "$t_external_navigated" "$t_resolve_start" "$t_resolve_end" \
  "$resolve_rc" \
<<'PY'
import sys, json
(artifact_path, resolve_raw_path, session_dump_path,
 intent, url, domain,
 external_chrome_pid, debug_port,
 kuri_pids_before, kuri_pids_after,
 t_start, t_chrome_ready, t_external_navigated, t_resolve_start, t_resolve_end,
 resolve_rc) = sys.argv[1:17]
def loadj(p):
    try: return json.load(open(p))
    except Exception: return {}
resolve = loadj(resolve_raw_path)
session = loadj(session_dump_path)
def first(d, *keys):
    for k in keys:
        if isinstance(d, dict) and k in d and d[k] is not None:
            return d[k]
    return None
before_set = set(p for p in kuri_pids_before.split() if p)
after_set = set(p for p in kuri_pids_after.split() if p)
new_kuri = sorted(after_set - before_set)
ops = first(resolve, "available_operations", "operations") or []
sessions_list = session.get("sessions") or session.get("data") or []
attached_browser_pid = None
external_intercepted = None
for s in sessions_list:
    if s.get("browser_pid") and str(s["browser_pid"]) == str(external_chrome_pid):
        attached_browser_pid = s["browser_pid"]
    external_intercepted = s.get("intercepted_request_count") or external_intercepted
artifact = {
    "probe": "C — auto-CDP-attach",
    "intent": intent,
    "url": url,
    "domain": domain,
    "external_chrome": {
        "pid": int(external_chrome_pid),
        "debug_port": int(debug_port),
        "t_ready_ms": int(t_chrome_ready) - int(t_start),
        "t_navigated_ms": int(t_external_navigated) - int(t_start),
    },
    "kuri_pids_before_resolve": sorted(list(before_set)),
    "kuri_pids_after_resolve": sorted(list(after_set)),
    "new_kuri_pids_during_resolve": new_kuri,
    "kuri_was_launched_by_unbrowse": bool(new_kuri),
    "attached_browser_pid": attached_browser_pid,
    "attached_external_chrome": (
        attached_browser_pid is not None and str(attached_browser_pid) == str(external_chrome_pid)
    ),
    "external_chrome_intercepted_requests": external_intercepted,
    "resolve": {
        "exit_code": int(resolve_rc),
        "source": first(resolve, "source"),
        "has_available_operations": bool(ops),
        "n_operations": len(ops),
        "t_resolve_ms": int(t_resolve_end) - int(t_resolve_start),
    },
    "resolve_raw_path": resolve_raw_path,
    "session_dump_path": session_dump_path,
}
open(artifact_path,"w").write(json.dumps(artifact, indent=2))
PY

append_to_manifest "probe-c-cdp-attach" "$ARTIFACT"

# Cleanup
$UNBROWSE_BIN close >/dev/null 2>&1 || true
kill "$EXTERNAL_CHROME_PID" 2>/dev/null || true
sleep 1
kill -9 "$EXTERNAL_CHROME_PID" 2>/dev/null || true
pkill -9 -f 'kuri' 2>/dev/null || true

echo "[probe-c] artifact: $ARTIFACT" >&2
exit 0
