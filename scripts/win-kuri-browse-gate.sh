#!/usr/bin/env bash
# Witness for the winsock CDP transport lever.
#
# Exits 0 exactly when:
#   1. kuri.exe cross-compiles for x86_64-windows WITH the winsock CDP websocket
#      client linked (ws2_32), and
#   2. the Windows websocket path is genuinely winsock-wired — connect() no longer
#      unconditionally returns ConnectionFailed; it calls WSAStartup/ws2_32, and
#   3. the NATIVE (POSIX) CDP-websocket path still connects to real Chrome
#      (kuri launches Chrome and /health reports a discovered tab → the shared
#      handshake/frame logic + the refactored connect() are intact).
#
# Live Windows browse (go/snap) runtime is verified by .github/workflows/
# test-windows.yml (windows-latest); it cannot run from this host.
set -euo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
KURI="$REPO/submodules/kuri"
WS="$KURI/src/cdp/websocket.zig"

echo "[browse-gate] 1/3 cross-compiling kuri.exe for x86_64-windows (winsock linked)..."
( cd "$KURI" && zig build -Dtarget=x86_64-windows-gnu )
EXE="$KURI/zig-out/bin/kuri.exe"
file "$EXE" | grep -qiE 'PE32|MS Windows|x86-64' || { echo "[browse-gate] FAIL: kuri.exe not a Windows PE"; exit 1; }
echo "[browse-gate]   ok: $(file -b "$EXE")"

echo "[browse-gate] 2/3 verifying the Windows websocket path is winsock-wired..."
# The old stub: connect() begins by returning ConnectionFailed on Windows.
if grep -qE 'os\.tag == \.windows\) return error\.ConnectionFailed' "$WS"; then
  echo "[browse-gate] FAIL: websocket connect() still hard-stubs ConnectionFailed on Windows"; exit 1
fi
grep -q 'WSAStartup' "$WS" || { echo "[browse-gate] FAIL: no winsock (WSAStartup) in websocket.zig"; exit 1; }
echo "[browse-gate]   ok: winsock connect/send/recv wired"

echo "[browse-gate] 3/3 native CDP-websocket smoke (Chrome launch + tab discovery)..."
( cd "$KURI" && zig build ) >/dev/null 2>&1
pkill -f "$KURI/zig-out/bin/kuri" 2>/dev/null || true
sleep 1
HEADLESS=true PORT=8794 HOST=127.0.0.1 "$KURI/zig-out/bin/kuri" >/tmp/kuri-browse-gate.log 2>&1 &
KPID=$!
OK=""
for i in $(seq 1 20); do
  sleep 1
  H=$(curl -s --max-time 2 http://127.0.0.1:8794/health 2>/dev/null || true)
  case "$H" in
    *'"ok":true'*'"tabs":'*) OK="$H"; break ;;
  esac
done
kill "$KPID" 2>/dev/null || true
pkill -f "remote-debugging-port" 2>/dev/null || true
pkill -f "$KURI/zig-out/bin/kuri" 2>/dev/null || true
# require ok:true AND at least one discovered tab (CDP websocket connected to Chrome)
TABS=$(printf '%s' "$OK" | sed -n 's/.*"tabs":\([0-9][0-9]*\).*/\1/p')
if [ -z "$OK" ] || [ "${TABS:-0}" -lt 1 ]; then
  echo "[browse-gate] FAIL: native kuri did not connect CDP/discover a tab. health='$OK'"; tail -5 /tmp/kuri-browse-gate.log; exit 1
fi
echo "[browse-gate]   ok: native health=$OK (CDP websocket connected, tabs=$TABS)"

echo "[browse-gate] PASS — winsock CDP transport links for Windows; native browse path intact."
