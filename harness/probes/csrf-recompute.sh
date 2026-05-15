#!/usr/bin/env bash
# csrf-recompute.sh — drive the CSRF refetch chain end-to-end.
#
# Boots the synthetic csrf-server.mjs on a random port, then drives:
#   1. GET  /csrf                    → fresh token + Max-Age=5
#   2. POST /protected (fresh token) → expect 200
#   3. sleep 6s                      → token rotates past Max-Age=5
#   4. POST /protected (stale token) → expect 403 csrf_invalid
#   5. GET  /csrf                    → fresh token (refetch)
#   6. POST /protected (fresh token) → expect 200
#
# Raw artifacts → .harness-out/csrf-recompute-<timestamp>/:
#   - server.log                                    (stdout from synthetic server)
#   - step01-csrf-init.{headers,body,curl-exit}
#   - step02-protected-fresh.{headers,body,curl-exit}
#   - step03-protected-stale.{headers,body,curl-exit}
#   - step04-csrf-refetch.{headers,body,curl-exit}
#   - step05-protected-after-refetch.{headers,body,curl-exit}
#   - summary.txt                                   (one line per step)
#
# Exit codes:
#   0 — server booted, every curl invocation returned (regardless of HTTP status)
#   1 — server failed to boot within the boot window
#
# NEVER emits a PASS/FAIL verdict. The calling agent reads the artifacts and
# judges in-thread, per feedback_agent_is_the_harness and
# feedback_no_heuristics_in_judge_jobs.
#
# Fallback note (NOT IMPLEMENTED — future work): instead of csrf-server.mjs we
# could drive a self-hosted gitea (which issues a CSRF cookie + _csrf form
# field) or OWASP Juice Shop docker container. The synthetic local server is
# preferred because it is hermetic, has no external dependencies, has a
# predictable 5s rotation, and surfaces the exact refetch chain without
# noise from a real app's auth/session machinery.
#
# Usage:
#   bash harness/probes/csrf-recompute.sh
#   bash harness/probes/csrf-recompute.sh --keep    # don't auto-kill server
set -uo pipefail

KEEP_SERVER=0
for arg in "$@"; do
  case "$arg" in
    --keep) KEEP_SERVER=1 ;;
    *) ;;
  esac
done

HERE="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$HERE/../.." && pwd)"
TS="$(date -u +%Y%m%dT%H%M%SZ)"
ART_DIR="$REPO_ROOT/.harness-out/csrf-recompute-$TS"
mkdir -p "$ART_DIR"

SERVER_LOG="$ART_DIR/server.log"
SERVER_PID=""

cleanup() {
  if [ -n "$SERVER_PID" ] && [ "$KEEP_SERVER" -ne 1 ]; then
    kill -TERM "$SERVER_PID" 2>/dev/null || true
    # Give it a moment, then SIGKILL if still alive.
    sleep 0.3
    kill -KILL "$SERVER_PID" 2>/dev/null || true
  fi
}
trap cleanup EXIT INT TERM

# Boot the synthetic server on a random port.
node "$HERE/csrf-server.mjs" 0 >"$SERVER_LOG" 2>&1 &
SERVER_PID=$!

# Wait for "listening on http://127.0.0.1:<PORT>" line. Up to 5s.
PORT=""
for _ in $(seq 1 50); do
  if [ -s "$SERVER_LOG" ]; then
    line="$(grep -E '^listening on http://127\.0\.0\.1:[0-9]+' "$SERVER_LOG" | head -n1)"
    if [ -n "$line" ]; then
      PORT="${line##*:}"
      break
    fi
  fi
  sleep 0.1
done

if [ -z "$PORT" ]; then
  echo "csrf-recompute: server failed to boot within window" >&2
  echo "csrf-recompute: artifacts at $ART_DIR" >&2
  exit 1
fi

BASE="http://127.0.0.1:$PORT"
echo "csrf-recompute: server up on $BASE (pid=$SERVER_PID)" >&2
echo "csrf-recompute: artifacts → $ART_DIR" >&2

SUMMARY="$ART_DIR/summary.txt"
: >"$SUMMARY"

# ---- helpers ----------------------------------------------------------------

# Issue a curl request, writing headers / body / exit / summary line.
# Args: step_name method url [extra-curl-args...]
do_curl() {
  local step="$1"; shift
  local method="$1"; shift
  local url="$1"; shift

  local headers_file="$ART_DIR/$step.headers"
  local body_file="$ART_DIR/$step.body"
  local exit_file="$ART_DIR/$step.curl-exit"
  local ts; ts="$(date -u +%Y-%m-%dT%H:%M:%S.%3NZ 2>/dev/null || date -u +%Y-%m-%dT%H:%M:%SZ)"

  curl -sS -X "$method" \
    -D "$headers_file" \
    -o "$body_file" \
    -w "%{http_code}" \
    "$@" \
    "$url" >"$ART_DIR/$step.http-status" 2>"$ART_DIR/$step.curl-stderr"
  local rc=$?
  echo "$rc" >"$exit_file"

  local status
  status="$(cat "$ART_DIR/$step.http-status" 2>/dev/null || echo '?')"
  echo "$ts step=$step method=$method url=$url curl_exit=$rc http_status=$status" >>"$SUMMARY"
}

# Extract csrf_token from a JSON body file. No verdict, just parsing.
# Uses node so we don't depend on jq.
extract_token() {
  local body_file="$1"
  node -e '
    const fs = require("node:fs");
    try {
      const j = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
      if (j && typeof j.csrf_token === "string") {
        process.stdout.write(j.csrf_token);
      }
    } catch (_) {}
  ' "$body_file"
}

# ---- sequence ---------------------------------------------------------------

# Step 1: GET /csrf — initial token.
do_curl "step01-csrf-init" "GET" "$BASE/csrf"
TOKEN_INITIAL="$(extract_token "$ART_DIR/step01-csrf-init.body")"
echo "# step01 token_extracted_len=${#TOKEN_INITIAL}" >>"$SUMMARY"

# Step 2: POST /protected with fresh token.
do_curl "step02-protected-fresh" "POST" "$BASE/protected" \
  -H "X-CSRF-Token: $TOKEN_INITIAL" \
  -H "Content-Type: application/json" \
  --data '{"action":"execute","stage":"fresh"}'

# Sleep past the Max-Age=5 window.
echo "# sleeping 6s to let token expire (Max-Age=5)" >>"$SUMMARY"
sleep 6

# Step 3: POST /protected with the now-stale token.
do_curl "step03-protected-stale" "POST" "$BASE/protected" \
  -H "X-CSRF-Token: $TOKEN_INITIAL" \
  -H "Content-Type: application/json" \
  --data '{"action":"execute","stage":"stale"}'

# Step 4: GET /csrf — refetch.
do_curl "step04-csrf-refetch" "GET" "$BASE/csrf"
TOKEN_FRESH="$(extract_token "$ART_DIR/step04-csrf-refetch.body")"
echo "# step04 token_extracted_len=${#TOKEN_FRESH} differs_from_initial=$([ "$TOKEN_FRESH" != "$TOKEN_INITIAL" ] && echo yes || echo no)" >>"$SUMMARY"

# Step 5: POST /protected with the fresh token.
do_curl "step05-protected-after-refetch" "POST" "$BASE/protected" \
  -H "X-CSRF-Token: $TOKEN_FRESH" \
  -H "Content-Type: application/json" \
  --data '{"action":"execute","stage":"after-refetch"}'

echo "# Read these artifacts and judge in-thread." >>"$SUMMARY"

# Server log will be flushed on shutdown via trap.
exit 0
