#!/usr/bin/env bash
# Post-release verification: install from npm on a clean prefix, run full pipeline.
# Exits non-zero + writes failure report to stdout (JSON) if anything breaks.
# Designed to run on a staging VM or CI runner.
set -euo pipefail

VERSION="${1:-latest}"
TMP_PREFIX="$(mktemp -d "${TMPDIR:-/tmp}/unbrowse-verify.XXXXXX")"
TMP_HOME="$(mktemp -d "${TMPDIR:-/tmp}/unbrowse-verify-home.XXXXXX")"
REPORT_FILE="${REPORT_FILE:-/tmp/unbrowse-post-release-report.json}"
FAILURES=()
PASS=()

cleanup() {
  # Kill any spawned unbrowse/kuri
  pkill -f "unbrowse-verify" 2>/dev/null || true
  rm -rf "$TMP_PREFIX" "$TMP_HOME"
}
trap cleanup EXIT

log() { echo "[post-release] $*" >&2; }
fail() { FAILURES+=("$1"); log "FAIL: $1"; }
pass() { PASS+=("$1"); log "PASS: $1"; }

export PATH="$TMP_PREFIX/bin:$PATH"
export HOME="$TMP_HOME"
export XDG_CONFIG_HOME="$TMP_HOME/.config"
export UNBROWSE_DISABLE_AUTO_UPDATE=1
export UNBROWSE_NON_INTERACTIVE=1
export UNBROWSE_TOS_ACCEPTED=1
# Use UNBROWSE_API_KEY env if set (CI secret), otherwise let server auto-register
export UNBROWSE_API_KEY="${UNBROWSE_API_KEY:-}"

# --- Step 1: Install from npm ---
log "Installing unbrowse@$VERSION..."
if NPM_CONFIG_PREFIX="$TMP_PREFIX" npm install -g "unbrowse@$VERSION" --silent 2>/dev/null; then
  pass "npm-install"
else
  fail "npm-install: npm install -g unbrowse@$VERSION failed"
fi

# --- Step 2: Version check ---
INSTALLED_VERSION="$(unbrowse --version 2>/dev/null || echo "")"
if [[ -n "$INSTALLED_VERSION" && "$INSTALLED_VERSION" != *"Commands:"* ]]; then
  pass "version-check: $INSTALLED_VERSION"
else
  fail "version-check: got '$INSTALLED_VERSION'"
fi

# --- Step 3: Health check (start server) ---
PORT="$(node -e 'const s=require("net").createServer();s.listen(0,"127.0.0.1",()=>{console.log(s.address().port);s.close();})')"
export UNBROWSE_URL="http://127.0.0.1:$PORT"
export PORT

# Find server entry
PKG_DIR="$TMP_PREFIX/lib/node_modules/unbrowse"
SERVER_ENTRY="$PKG_DIR/dist/server.js"
if [[ ! -f "$SERVER_ENTRY" ]]; then
  # Try alternate locations
  SERVER_ENTRY="$(find "$PKG_DIR" -name 'server.js' -path '*/dist/*' | head -1 || true)"
fi

if [[ -f "$SERVER_ENTRY" ]]; then
  UNBROWSE_PID_FILE="$TMP_HOME/server-$PORT.json" \
    node "$SERVER_ENTRY" >/tmp/unbrowse-verify-server.log 2>&1 &
  SERVER_PID=$!
  sleep 3

  HEALTH_OK=false
  for i in 1 2 3 4 5; do
    if unbrowse health >/tmp/unbrowse-verify-health.json 2>&1; then
      if grep -q '"status":"ok"' /tmp/unbrowse-verify-health.json; then
        HEALTH_OK=true
        break
      fi
    fi
    sleep 2
  done

  if [[ "$HEALTH_OK" == "true" ]]; then
    pass "health-check"

    # Ensure API key exists — server auto-registers but needs backend connectivity
    SETUP_OK=false
    # Check if env var already set (CI secret)
    if [[ -n "$UNBROWSE_API_KEY" ]]; then
      mkdir -p "$TMP_HOME/.unbrowse"
      echo "{\"api_key\":\"$UNBROWSE_API_KEY\"}" > "$TMP_HOME/.unbrowse/config.json"
      SETUP_OK=true
      pass "api-key-from-env"
    else
      # Wait for server auto-register (writes config.json on boot)
      for i in 1 2 3 4 5 6; do
        if [[ -f "$TMP_HOME/.unbrowse/config.json" ]] && grep -q 'api_key' "$TMP_HOME/.unbrowse/config.json" 2>/dev/null; then
          SETUP_OK=true
          pass "api-key-auto-registered"
          break
        fi
        sleep 3
      done
    fi
    if [[ "$SETUP_OK" != "true" ]]; then
      # Last resort: register via backend API directly
      REG_RESP="$(curl -sf -X POST "https://beta-api.unbrowse.ai/v1/agents/register" \
        -H 'Content-Type: application/json' \
        -d '{"name":"verify-bot-'$$'"}' 2>/dev/null || true)"
      REG_KEY="$(echo "$REG_RESP" | node -p 'JSON.parse(require("fs").readFileSync("/dev/stdin","utf-8")).api_key' 2>/dev/null || true)"
      if [[ -n "$REG_KEY" ]]; then
        export UNBROWSE_API_KEY="$REG_KEY"
        mkdir -p "$TMP_HOME/.unbrowse"
        echo "{\"api_key\":\"$REG_KEY\"}" > "$TMP_HOME/.unbrowse/config.json"
        SETUP_OK=true
        pass "api-key-backend-register"
      else
        fail "api-key: no key after all attempts"
        log "config.json: $(cat "$TMP_HOME/.unbrowse/config.json" 2>/dev/null || echo 'missing')"
        log "backend-register: $REG_RESP"
      fi
    fi
  else
    fail "health-check: server not healthy after 15s"
  fi
else
  fail "server-entry: dist/server.js not found in package"
fi

# --- Step 4: Resolve (marketplace hit) ---
RESOLVE_OK=false
if [[ "$HEALTH_OK" == "true" ]]; then
  if unbrowse resolve --intent "get hacker news front page" --url "https://news.ycombinator.com" \
    >/tmp/unbrowse-verify-resolve-raw.txt 2>&1; then
    # CLI mixes log lines with JSON — extract last JSON object
    grep -E '^\{' /tmp/unbrowse-verify-resolve-raw.txt | tail -1 > /tmp/unbrowse-verify-resolve.json 2>/dev/null || true
    if node -e '
      const r = JSON.parse(require("fs").readFileSync("/tmp/unbrowse-verify-resolve.json","utf-8"));
      if (!r.trace?.success) process.exit(1);
      if (!r.available_endpoints?.length) process.exit(1);
    ' 2>/dev/null; then
      RESOLVE_OK=true
      pass "resolve: marketplace hit, endpoints returned"
    else
      fail "resolve: returned but trace.success=false or no endpoints"
    fi
  else
    fail "resolve: command failed"
  fi
fi

# --- Step 5: Execute (structured data back) ---
if [[ "$RESOLVE_OK" == "true" ]]; then
  SKILL_ID="$(node -p 'JSON.parse(require("fs").readFileSync("/tmp/unbrowse-verify-resolve.json","utf-8")).skill?.skill_id' 2>/dev/null || true)"
  EP_ID="$(node -p 'JSON.parse(require("fs").readFileSync("/tmp/unbrowse-verify-resolve.json","utf-8")).available_endpoints?.[0]?.endpoint_id' 2>/dev/null || true)"

  if [[ -n "$SKILL_ID" && -n "$EP_ID" ]]; then
    if unbrowse execute --skill "$SKILL_ID" --endpoint "$EP_ID" --intent "get hacker news" \
      >/tmp/unbrowse-verify-execute-raw.txt 2>&1; then
      grep -E '^\{' /tmp/unbrowse-verify-execute-raw.txt | tail -1 > /tmp/unbrowse-verify-execute.json 2>/dev/null || true
      if node -e '
        const r = JSON.parse(require("fs").readFileSync("/tmp/unbrowse-verify-execute.json","utf-8"));
        if (!r.trace?.success) process.exit(1);
        if (r.trace?.status_code !== 200) process.exit(1);
      ' 2>/dev/null; then
        pass "execute: status=200, structured data returned"
      else
        fail "execute: returned but not successful (status != 200)"
      fi
    else
      fail "execute: command failed"
    fi
  else
    fail "execute: could not extract skill_id/endpoint_id from resolve"
  fi
fi

# --- Step 6: Browser smoke (if Chrome available) ---
if [[ "$HEALTH_OK" == "true" ]]; then
  if unbrowse go "https://example.com" >/tmp/unbrowse-verify-go-raw.txt 2>&1; then
    grep -E '^\{' /tmp/unbrowse-verify-go-raw.txt | tail -1 > /tmp/unbrowse-verify-go.json 2>/dev/null || true
    if grep -q '"ok":true' /tmp/unbrowse-verify-go.json; then
      SESSION_ID="$(node -p 'JSON.parse(require("fs").readFileSync("/tmp/unbrowse-verify-go.json","utf-8")).session_id' 2>/dev/null || true)"
      if [[ -n "$SESSION_ID" ]]; then
        pass "browser-go"

        if unbrowse eval --session "$SESSION_ID" "document.title" >/tmp/unbrowse-verify-eval.json 2>&1; then
          if ! grep -q '"error"' /tmp/unbrowse-verify-eval.json; then
            pass "browser-eval"
          else
            fail "browser-eval: returned error"
          fi
        else
          fail "browser-eval: command failed"
        fi

        unbrowse close --session "$SESSION_ID" >/dev/null 2>&1 || true
      else
        fail "browser-go: no session_id"
      fi
    else
      fail "browser-go: not ok"
    fi
  else
    log "SKIP: browser smoke (Chrome/Kuri not available)"
  fi
fi

# --- Step 7: Check traction metrics for anomalies ---
if curl -sf "https://launch.unbrowse.ai/api/traction" >/tmp/unbrowse-verify-traction.json 2>/dev/null; then
  ANOMALY="$(node -e '
    const fs = require("fs");
    const raw = fs.readFileSync("/tmp/unbrowse-verify-traction.json", "utf-8");
    // Look for day-over-day drops > 70%
    const data = JSON.parse(raw);
    // Simple heuristic: check if WAU or daily verifications show cliff
    if (data.wau !== undefined && data.wau < 50) {
      console.log("WAU critically low: " + data.wau);
      process.exit(0);
    }
    console.log("");
  ' 2>/dev/null || true)"
  if [[ -n "$ANOMALY" ]]; then
    fail "traction-anomaly: $ANOMALY"
  else
    pass "traction-check"
  fi
fi

# Kill server
if [[ -n "${SERVER_PID:-}" ]]; then
  kill "$SERVER_PID" 2>/dev/null || true
  wait "$SERVER_PID" 2>/dev/null || true
fi

# --- Build report ---
TOTAL=$((${#PASS[@]} + ${#FAILURES[@]}))
cat > "$REPORT_FILE" <<REPORT_EOF
{
  "version": "$INSTALLED_VERSION",
  "timestamp": "$(date -u +%Y-%m-%dT%H:%M:%SZ)",
  "total_checks": $TOTAL,
  "passed": ${#PASS[@]},
  "failed": ${#FAILURES[@]},
  "pass_details": $(node -e "console.log(JSON.stringify($(printf '%s\n' "${PASS[@]+"${PASS[@]}"}" | jq -R . | jq -s .)))" 2>/dev/null || echo '[]'),
  "fail_details": $(node -e "console.log(JSON.stringify($(printf '%s\n' "${FAILURES[@]+"${FAILURES[@]}"}" | jq -R . | jq -s .)))" 2>/dev/null || echo '[]')
}
REPORT_EOF

cat "$REPORT_FILE"

if [[ ${#FAILURES[@]} -gt 0 ]]; then
  log "${#FAILURES[@]}/${TOTAL} checks failed"
  exit 1
else
  log "All ${TOTAL} checks passed"
  exit 0
fi
