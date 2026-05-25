#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
WORKSPACE_DIR="$ROOT_DIR/packages/skill"

TMP_PREFIX="$(mktemp -d "${TMPDIR:-/tmp}/unbrowse-packaged-prefix.XXXXXX")"
TMP_HOME="$(mktemp -d "${TMPDIR:-/tmp}/unbrowse-packaged-home.XXXXXX")"
PORT="${UNBROWSE_PACKAGED_SMOKE_PORT:-$(node -e 'const net=require("node:net"); const s=net.createServer(); s.listen(0, "127.0.0.1", () => { console.log(s.address().port); s.close(); });')}"
SERVER_PID=""
TARBALL=""
RUNTIME_ENTRY=""

cleanup() {
  if [[ -n "$SERVER_PID" ]]; then
    # SIGTERM first, then SIGKILL if still alive after 2s. Previously this
    # did `kill + wait` which hung CI for 27 minutes when the bun server
    # didn't respond to SIGTERM — the whole release pipeline stalled.
    kill -TERM "$SERVER_PID" >/dev/null 2>&1 || true
    for i in 1 2 3 4; do
      if ! kill -0 "$SERVER_PID" 2>/dev/null; then break; fi
      sleep 0.5
    done
    kill -KILL "$SERVER_PID" >/dev/null 2>&1 || true
    # Drop the wait — a detached bun child can inherit the server PID and
    # outlive the kill, and `wait` on a non-child will block forever.
  fi
  # Also sweep any orphan bun/unbrowse/kuri descendants spawned by the smoke
  pkill -9 -P $$ 2>/dev/null || true
  pkill -9 -f "$RUNTIME_ENTRY" 2>/dev/null || true
  if [[ -n "$TARBALL" && -f "$TARBALL" ]]; then
    rm -f "$TARBALL"
  fi
  rm -rf "$TMP_PREFIX" "$TMP_HOME"
}
trap cleanup EXIT

run_with_timeout() {
  local seconds="$1"
  shift
  node -e '
const { spawn } = require("node:child_process");
const seconds = Number(process.argv[1]);
const cmd = process.argv[2];
const args = process.argv.slice(3);
const child = spawn(cmd, args, { stdio: "inherit" });
const timer = setTimeout(() => {
  child.kill("SIGTERM");
  setTimeout(() => child.kill("SIGKILL"), 2000).unref();
}, Math.max(1, seconds) * 1000);
child.on("exit", (code, signal) => {
  clearTimeout(timer);
  process.exit(signal ? 124 : (code ?? 1));
});
' "$seconds" "$@"
}

pushd "$ROOT_DIR" >/dev/null
TARBALL="$(npm pack --workspace packages/skill | tail -n 1)"
popd >/dev/null

# Build the local binary so postinstall doesn't need to download from GitHub releases.
# This prevents failures when release assets don't exist yet (test runs vs release runs).
LOCAL_BIN="$ROOT_DIR/dist/unbrowse"
if [[ ! -x "$LOCAL_BIN" ]]; then
  bash "$ROOT_DIR/scripts/build-binaries.sh" 2>/dev/null || true
fi
if [[ -x "$LOCAL_BIN" ]]; then
  UNBROWSE_INSTALL_BINARY_PATH="$LOCAL_BIN" NPM_CONFIG_PREFIX="$TMP_PREFIX" npm install -g "$ROOT_DIR/$TARBALL" --silent
else
  NPM_CONFIG_PREFIX="$TMP_PREFIX" npm install -g "$ROOT_DIR/$TARBALL" --silent
fi

BIN="$TMP_PREFIX/bin/unbrowse"
PKG_DIR="$TMP_PREFIX/lib/node_modules/unbrowse"
RUNTIME_ENTRY="$BIN"
PID_FILE="$TMP_HOME/server-$PORT.json"

test -x "$BIN"
VERSION="$("$BIN" --version)"
if [[ -z "$VERSION" || "$VERSION" == *"Commands:"* ]]; then
  echo "[packaged-cli-smoke] bad --version output: $VERSION" >&2
  exit 1
fi

HOME="$TMP_HOME" XDG_CONFIG_HOME="$TMP_HOME/.config" \
  PORT="$PORT" UNBROWSE_PID_FILE="$PID_FILE" \
  UNBROWSE_DISABLE_AUTO_UPDATE=1 UNBROWSE_NON_INTERACTIVE=1 UNBROWSE_TOS_ACCEPTED=1 \
  UNBROWSE_BROWSE_LIVENESS_DEBUG=1 \
  "$BIN" serve >/tmp/unbrowse-packaged-cli-server.log 2>&1 &
SERVER_PID=$!
sleep 2

# Health check with retry — server may need a few seconds on CI
HEALTH_OK=false
for i in 1 2 3 4 5; do
  if HOME="$TMP_HOME" XDG_CONFIG_HOME="$TMP_HOME/.config" \
    UNBROWSE_DISABLE_AUTO_UPDATE=1 UNBROWSE_NON_INTERACTIVE=1 UNBROWSE_TOS_ACCEPTED=1 \
    UNBROWSE_URL="http://127.0.0.1:$PORT" \
    "$BIN" health >/tmp/unbrowse-packaged-cli-health.json 2>&1; then
    HEALTH_OK=true
    break
  fi
  sleep 2
done

if [[ "$HEALTH_OK" != "true" ]]; then
  echo "[packaged-cli-smoke] FATAL: health check failed after 5 retries" >&2
  cat /tmp/unbrowse-packaged-cli-server.log >&2 || true
  exit 1
fi

# Browser smoke (go + eval + snap + close) — requires Chrome on the CI runner.
# This is a hard gate: if go succeeds, eval and snap MUST work.
# This catches the multi-broker regression where go reports success but the tab
# never navigates (stays on about:blank) and all CDP commands fail.
BROWSER_AVAILABLE=true
CLI_ENV=(
  HOME="$TMP_HOME" XDG_CONFIG_HOME="$TMP_HOME/.config"
  UNBROWSE_DISABLE_AUTO_UPDATE=1 UNBROWSE_NON_INTERACTIVE=1 UNBROWSE_TOS_ACCEPTED=1
  UNBROWSE_URL="http://127.0.0.1:$PORT"
)

# Redirect stderr separately — CLI prints [domain-cache] etc. to stderr which breaks JSON parsing
set +e
run_with_timeout 45 env "${CLI_ENV[@]}" "$BIN" go "https://example.com" >/tmp/unbrowse-packaged-cli-go.json 2>/tmp/unbrowse-packaged-cli-go.log
GO_CODE=$?
set -e
if [[ "$GO_CODE" -ne 0 ]]; then
  BROWSER_AVAILABLE=false
fi

# If go returned a browse error (not ok:true), skip browser checks
if [[ "$BROWSER_AVAILABLE" == "true" ]] && ! grep -q '"ok":true' /tmp/unbrowse-packaged-cli-go.json; then
  BROWSER_AVAILABLE=false
fi

grep -q '"status":"ok"' /tmp/unbrowse-packaged-cli-health.json

if [[ "$BROWSER_AVAILABLE" == "true" ]]; then

  # Extract session_id for subsequent commands
  SESSION_ID="$(node -p 'JSON.parse(require("fs").readFileSync("/tmp/unbrowse-packaged-cli-go.json","utf-8")).session_id' 2>/dev/null || true)"
  if [[ -z "$SESSION_ID" ]]; then
    echo "[packaged-cli-smoke] FAIL: go returned ok but no session_id" >&2
    exit 1
  fi

  # eval must return real content — catches multi-broker tab-on-about:blank bug
  run_with_timeout 30 env "${CLI_ENV[@]}" "$BIN" eval --session "$SESSION_ID" "document.title" \
    >/tmp/unbrowse-packaged-cli-eval.json 2>/dev/null
  if grep -q '"error"' /tmp/unbrowse-packaged-cli-eval.json; then
    echo "[packaged-cli-smoke] FAIL: eval returned error after go success — tab likely not navigated" >&2
    cat /tmp/unbrowse-packaged-cli-eval.json >&2
    echo "[packaged-cli-smoke] --- server log (browse-liveness diagnostics) ---" >&2
    grep -E "browse-liveness|session_expired|tab_not_in_discover" /tmp/unbrowse-packaged-cli-server.log >&2 || tail -100 /tmp/unbrowse-packaged-cli-server.log >&2
    exit 1
  fi

  # snap must return a non-empty a11y tree
  run_with_timeout 30 env "${CLI_ENV[@]}" "$BIN" snap --session "$SESSION_ID" --filter interactive \
    >/tmp/unbrowse-packaged-cli-snap.txt 2>/dev/null
  if ! grep -q '\[e0\]' /tmp/unbrowse-packaged-cli-snap.txt; then
    echo "[packaged-cli-smoke] FAIL: snap returned empty a11y tree" >&2
    cat /tmp/unbrowse-packaged-cli-snap.txt >&2
    exit 1
  fi

  # close must succeed
  set +e
  run_with_timeout 30 env "${CLI_ENV[@]}" "$BIN" close --session "$SESSION_ID" \
    >/tmp/unbrowse-packaged-cli-close.json 2>/dev/null
  CLOSE_CODE=$?
  set -e
  if [[ "$CLOSE_CODE" -ne 0 ]] && ! grep -q '"ok":true' /tmp/unbrowse-packaged-cli-close.json; then
    echo "[packaged-cli-smoke] FAIL: close did not complete successfully" >&2
    cat /tmp/unbrowse-packaged-cli-close.json >&2 || true
    exit 1
  fi
  grep -q '"ok":true' /tmp/unbrowse-packaged-cli-close.json
else
  echo "[packaged-cli-smoke] WARN: browser smoke skipped (Chrome/Kuri not available)"
fi

echo "[packaged-cli-smoke] ok version=$VERSION"
