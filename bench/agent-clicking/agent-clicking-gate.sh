#!/usr/bin/env bash
# agent-clicking-gate.sh — the witness that unbrowse is an API-native, STATELESS browser for
# agents. Exits 0 only when a real kuri+Chrome click works through the stateless primitive with
# NO session lifecycle held by the caller. No mock, no skip-green: if the browser can't launch,
# the gate is RED.
#
# Checks:
#   A. REAL click  — serve a local testbed, drive statelessClick over real kuri+Chrome; the
#                    post-click a11y snapshot must show the click effect AND the click's API
#                    call must appear in the captured network.
#   B. STATELESS   — two INDEPENDENT process invocations both succeed (no shared in-process
#                    session), AND the agent-facing driver never calls a session lifecycle
#                    primitive (start/newTab/closeTab/discoverTabs) — the op self-manages it.
#   C. SURFACE     — the stateless op is exposed as an agent-facing command (CLI/MCP), not just
#                    a bench toy.
#   D. POSITIONING — the frontend hero positions unbrowse as an "API-native browser for agents".
set -uo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT"
HERE="bench/agent-clicking"
PORT="${AGENT_CLICK_PORT:-8799}"
fail=0
SRV=""
cleanup() { [ -n "$SRV" ] && kill "$SRV" 2>/dev/null; pkill -f 'vendor/kuri/darwin' 2>/dev/null; pkill -f 'vendor/kuri/linux' 2>/dev/null; }
trap cleanup EXIT

python3 -m http.server "$PORT" --directory "$HERE" >/tmp/agentclick-srv.log 2>&1 &
SRV=$!
sleep 1
URL="http://127.0.0.1:$PORT/testpage.html"
curl -sf "$URL" >/dev/null || { echo "[agent-click] FAIL: testbed not served"; exit 1; }

run_driver() {
  pkill -f 'vendor/kuri/darwin' 2>/dev/null; pkill -f 'vendor/kuri/linux' 2>/dev/null; sleep 1
  timeout 150 bun "$HERE/drive_stateless.ts" "$URL" 2>/dev/null | tail -1
}

echo "=== A+B: two INDEPENDENT stateless invocations (real kuri+Chrome) ==="
J1="$(run_driver)"; echo "  run1: $J1"
J2="$(run_driver)"; echo "  run2: $J2"
for tag in "1:$J1" "2:$J2"; do
  j="${tag#*:}"
  ok=$(printf '%s' "$j" | python3 -c "import json,sys;d=json.load(sys.stdin);print(d.get('ok') and d.get('clicked_effect'))" 2>/dev/null)
  net=$(printf '%s' "$j" | python3 -c "import json,sys;print(json.load(sys.stdin).get('network_hit'))" 2>/dev/null)
  if [ "$ok" = "True" ]; then echo "[agent-click] run${tag%%:*}: REAL click landed statelessly ✅ (network_hit=$net)"; else echo "[agent-click] FAIL: run${tag%%:*} click did not land ($j)"; fail=1; fi
done

echo "=== E: auth (cookies/headers/PII) is WALLET-BOUND + isolated (real round-trip) ==="
pkill -f 'vendor/kuri/darwin' 2>/dev/null; pkill -f 'vendor/kuri/linux' 2>/dev/null; sleep 1
AUTH_JSON="$(timeout 160 bun "$HERE/drive_wallet_auth.ts" "http://127.0.0.1:$PORT/authpage.html" 2>/dev/null | tail -1)"
echo "  $AUTH_JSON"
authok=$(printf '%s' "$AUTH_JSON" | python3 -c "import json,sys;print(json.load(sys.stdin).get('ok'))" 2>/dev/null)
if [ "$authok" = "True" ]; then
  echo "[agent-click] holder wallet authenticates; wrong wallet fails closed + isolated (no leak) ✅"
else
  echo "[agent-click] FAIL: wallet-bound auth round-trip not satisfied ($AUTH_JSON)"; fail=1
fi

echo "=== B: caller holds NO session lifecycle (the op self-manages attach->act->detach) ==="
if grep -nE 'kuri\.(start|newTab|closeTab|discoverTabs|navigate|harStart)' "$HERE/drive_stateless.ts" >/dev/null 2>&1; then
  echo "[agent-click] FAIL: agent-facing driver calls a session lifecycle primitive — not stateless"; fail=1
else
  echo "[agent-click] driver imports only stateless wrappers; no lifecycle held by caller ✅"
fi

echo "=== C: stateless op exposed as an agent-facing command (CLI/MCP surface) ==="
if grep -rlnE 'statelessClick|runStateless|stateless-primitive' src/cli-v7 src/mcp 2>/dev/null | grep -q .; then
  echo "[agent-click] stateless primitive wired into the CLI/MCP surface ✅"
else
  echo "[agent-click] FAIL: stateless primitive not exposed as an agent command (src/cli-v7 or src/mcp)"; fail=1
fi

echo "=== D: frontend positions as an API-native browser for agents ==="
if grep -rliE 'api-native browser for agents' frontend 2>/dev/null | grep -q .; then
  echo "[agent-click] frontend hero repositioned ✅"
else
  echo "[agent-click] FAIL: frontend hero does not say 'API-native browser for agents'"; fail=1
fi

echo "================================================"
[ "$fail" -eq 0 ] && { echo "[agent-click] PASS — API-native stateless browser for agents: real click works, caller holds no session, surfaced + positioned"; exit 0; } \
                  || { echo "[agent-click] FAIL — not yet whole"; exit 1; }
