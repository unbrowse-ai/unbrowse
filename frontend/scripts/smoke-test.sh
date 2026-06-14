#!/usr/bin/env bash
set -euo pipefail

# ── E2E Smoke Tests for Unbrowse Frontend ──
# Builds the app, starts the production server, and verifies key routes
# return 200 with expected content.

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"

# Pick a random port between 4000-4999 to avoid collisions
PORT=$((4000 + RANDOM % 1000))
BASE_URL="http://localhost:$PORT"
SERVER_PID=""
PASS=0
FAIL=0
FAILURES=""

cleanup() {
  if [[ -n "$SERVER_PID" ]]; then
    kill "$SERVER_PID" 2>/dev/null || true
    wait "$SERVER_PID" 2>/dev/null || true
  fi
  rm -rf "${TMPDIR_SMOKE:-}" 2>/dev/null || true
}
trap cleanup EXIT

log() { printf "\033[1;34m[smoke]\033[0m %s\n" "$1"; }
pass() { printf "\033[1;32m  PASS\033[0m %s\n" "$1"; PASS=$((PASS + 1)); }
fail() {
  printf "\033[1;31m  FAIL\033[0m %s - %s\n" "$1" "$2"
  FAIL=$((FAIL + 1))
  FAILURES="${FAILURES}\n  - $1: $2"
}

# ── Build ──
log "Building app in $PROJECT_DIR ..."
cd "$PROJECT_DIR"
bun run build 2>&1 | tail -5

# ── Start server ──
log "Starting production server on port $PORT ..."
PORT=$PORT bun run start &
SERVER_PID=$!

# Wait for server to be ready (up to 30s)
log "Waiting for server to be ready ..."
for i in $(seq 1 30); do
  if curl -sf "$BASE_URL" -o /dev/null 2>/dev/null; then
    break
  fi
  if ! kill -0 "$SERVER_PID" 2>/dev/null; then
    echo "Server process died during startup"
    exit 1
  fi
  sleep 1
done

if ! curl -sf "$BASE_URL" -o /dev/null 2>/dev/null; then
  echo "Server failed to start within 30s"
  exit 1
fi
log "Server ready at $BASE_URL (PID $SERVER_PID)"

# ── Test helper ──
# check_route <path> <expected_status> <content_type_contains> <body_contains>
TMPDIR_SMOKE=$(mktemp -d)
check_route() {
  local path="$1"
  local expected_status="$2"
  local content_type_match="$3"
  local body_match="$4"
  local label="$5"

  local url="$BASE_URL$path"
  local body_file="$TMPDIR_SMOKE/body.tmp"
  local http_code

  # Fetch body to file, capture status code
  http_code=$(curl -s -o "$body_file" -w "%{http_code}" -L "$url" 2>/dev/null) || {
    fail "$label ($path)" "curl failed"
    return
  }

  # Check status code
  if [[ "$http_code" != "$expected_status" ]]; then
    fail "$label ($path)" "expected HTTP $expected_status, got $http_code"
    return
  fi

  # Check content type if specified
  if [[ -n "$content_type_match" ]]; then
    local ct
    ct=$(curl -s -o /dev/null -w "%{content_type}" -L "$url" 2>/dev/null)
    if ! printf '%s' "$ct" | grep -qi "$content_type_match"; then
      fail "$label ($path)" "content-type '$ct' does not contain '$content_type_match'"
      return
    fi
  fi

  # Check body content if specified
  if [[ -n "$body_match" ]]; then
    if ! grep -qi "$body_match" "$body_file"; then
      fail "$label ($path)" "body does not contain '$body_match'"
      return
    fi
  fi

  pass "$label ($path)"
}

# ── Page Route Tests ──
log "Testing page routes ..."

check_route "/" "200" "text/html" "unbrowse" "Homepage"
check_route "/search" "200" "text/html" "" "Search page"
check_route "/blog" "200" "text/html" "" "Blog listing"
check_route "/papers" "200" "text/html" "" "Papers page"
check_route "/leaderboard" "200" "text/html" "" "Leaderboard"
check_route "/faq" "200" "text/html" "" "FAQ"
check_route "/terms" "200" "text/html" "" "Terms"
check_route "/privacy" "200" "text/html" "" "Privacy"
check_route "/internal-apis-are-all-you-need" "200" "text/html" "" "Internal APIs paper"
check_route "/shadow-apis-are-all-you-need" "200" "text/html" "" "Shadow APIs paper"

# ── API Route Tests ──
log "Testing API routes ..."

check_route "/skill.md" "200" "text/markdown" "unbrowse" "skill.md"
check_route "/llms.txt" "200" "text/plain" "Unbrowse" "llms.txt"
check_route "/mcp.json" "410" "application/json" "mcp_autoinstall_removed" "mcp.json removed"

# ── Summary ──
echo ""
log "Results: $PASS passed, $FAIL failed (out of $((PASS + FAIL)) tests)"

if [[ $FAIL -gt 0 ]]; then
  printf "\033[1;31mFailures:\033[0m%b\n" "$FAILURES"
  exit 1
fi

printf "\033[1;32mAll smoke tests passed.\033[0m\n"
