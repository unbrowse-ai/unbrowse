#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
WORKSPACE_DIR="$ROOT_DIR/packages/skill"

TMP_PREFIX="$(mktemp -d "${TMPDIR:-/tmp}/unbrowse-packaged-prefix.XXXXXX")"
TMP_HOME="$(mktemp -d "${TMPDIR:-/tmp}/unbrowse-packaged-home.XXXXXX")"
PORT="${UNBROWSE_PACKAGED_SMOKE_PORT:-$(node -e 'const net=require("node:net"); const s=net.createServer(); s.listen(0, "127.0.0.1", () => { console.log(s.address().port); s.close(); });')}"
SERVER_PID=""
TARBALL=""

cleanup() {
  if [[ -n "$SERVER_PID" ]]; then
    kill "$SERVER_PID" >/dev/null 2>&1 || true
    wait "$SERVER_PID" 2>/dev/null || true
  fi
  if [[ -n "$TARBALL" && -f "$TARBALL" ]]; then
    rm -f "$TARBALL"
  fi
  rm -rf "$TMP_PREFIX" "$TMP_HOME"
}
trap cleanup EXIT

pushd "$ROOT_DIR" >/dev/null
TARBALL="$(npm pack --workspace packages/skill | tail -n 1)"
popd >/dev/null

NPM_CONFIG_PREFIX="$TMP_PREFIX" npm install -g "$ROOT_DIR/$TARBALL" --silent

BIN="$TMP_PREFIX/bin/unbrowse"
RUNTIME_ENTRY="$TMP_PREFIX/lib/node_modules/unbrowse/runtime-src/index.ts"
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
  bun "$RUNTIME_ENTRY" >/tmp/unbrowse-packaged-cli-server.log 2>&1 &
SERVER_PID=$!
sleep 2

HOME="$TMP_HOME" XDG_CONFIG_HOME="$TMP_HOME/.config" \
  UNBROWSE_DISABLE_AUTO_UPDATE=1 UNBROWSE_NON_INTERACTIVE=1 UNBROWSE_TOS_ACCEPTED=1 \
  UNBROWSE_URL="http://127.0.0.1:$PORT" \
  "$BIN" health >/tmp/unbrowse-packaged-cli-health.json

HOME="$TMP_HOME" XDG_CONFIG_HOME="$TMP_HOME/.config" \
  UNBROWSE_DISABLE_AUTO_UPDATE=1 UNBROWSE_NON_INTERACTIVE=1 UNBROWSE_TOS_ACCEPTED=1 \
  UNBROWSE_URL="http://127.0.0.1:$PORT" \
  "$BIN" go "https://example.com" >/tmp/unbrowse-packaged-cli-go.json

HOME="$TMP_HOME" XDG_CONFIG_HOME="$TMP_HOME/.config" \
  UNBROWSE_DISABLE_AUTO_UPDATE=1 UNBROWSE_NON_INTERACTIVE=1 UNBROWSE_TOS_ACCEPTED=1 \
  UNBROWSE_URL="http://127.0.0.1:$PORT" \
  "$BIN" snap --filter interactive >/tmp/unbrowse-packaged-cli-snap.txt

grep -q '"status":"ok"' /tmp/unbrowse-packaged-cli-health.json
grep -q '"ok":true' /tmp/unbrowse-packaged-cli-go.json
grep -q '\[e0\]' /tmp/unbrowse-packaged-cli-snap.txt

echo "[packaged-cli-smoke] ok version=$VERSION"
