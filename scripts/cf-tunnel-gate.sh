#!/usr/bin/env bash
# cf-tunnel-gate — witness for "unbrowse, exposed publicly via a Cloudflare Tunnel
# opened FROM the mac mini, no Worker deploy." Exit 0 iff a curl of the PUBLIC
# hostname returns live unbrowse data.
#
# ARCHITECTURE (verified live 2026-06-03):
#   public  https://unbrowse-mini.getfoundry.app
#     -> Cloudflare edge
#     -> named tunnel `unbrowse-mini` (87b52a6a-…) running on the mac mini under
#        launchd `com.unbrowse.mini-tunnel` (persists across SSH disconnect + reboot)
#     -> origin http://100.98.157.91:8799  (this machine's unbrowse shim, over Tailscale)
#     -> `unbrowse search` on real route graph -> real data
#   Quick (*.trycloudflare.com) tunnels are BLOCKED in this environment (QUIC edge
#   never connects — verified from both this machine and the mac mini), so a NAMED
#   tunnel is the only working path. The production tunnel c9f1408a (docs.getfoundry.app,
#   *.unreel.ai, supabase.unbrowse.ai) is dashboard-managed — NEVER touch it; this is a
#   separate dedicated tunnel.
#   NEXT SLICE (not yet): run unbrowse natively on the mac mini (copy the self-contained
#   arm64 binary + vendor + key) so the origin no longer depends on this machine.
set -uo pipefail
cd "$(dirname "$0")/.."
set -a; . ./.env 2>/dev/null || true; set +a
PORT="${UNBROWSE_SHIM_PORT:-8799}"
PUB="${UNBROWSE_TUNNEL_URL:-https://unbrowse-mini.getfoundry.app}"
SHIM_LOG=/tmp/unbrowse-shim.log

# 1. origin: local unbrowse shim up + reachable over Tailscale (bind 0.0.0.0)?
if ! curl -fsS "http://127.0.0.1:${PORT}/health" >/dev/null 2>&1; then
  echo "[cf-tunnel] starting unbrowse shim on 0.0.0.0:${PORT} (Tailscale-reachable origin)"
  UNBROWSE_SHIM_HOST=0.0.0.0 UNBROWSE_SHIM_PORT="$PORT" nohup python3 scripts/unbrowse-http-shim.py >"$SHIM_LOG" 2>&1 &
  for _ in $(seq 1 20); do curl -fsS "http://127.0.0.1:${PORT}/health" >/dev/null 2>&1 && break; sleep 0.5; done
fi
curl -fsS "http://127.0.0.1:${PORT}/health" >/dev/null 2>&1 || { echo "[cf-tunnel] FAIL: local shim origin not healthy"; tail -3 "$SHIM_LOG" 2>/dev/null; exit 1; }
echo "[cf-tunnel] origin shim healthy on :${PORT}"

# 2. WITNESS: the PUBLIC mac-mini tunnel serves unbrowse.
ready=0
for i in $(seq 1 20); do
  curl -fsS --max-time 15 "${PUB}/health" 2>/dev/null | grep -q '"ok": *true' && { ready=1; break; }
  sleep 3
done
[ "$ready" -eq 1 ] || { echo "[cf-tunnel] FAIL: public ${PUB}/health never returned ok (mac-mini tunnel down? check launchd com.unbrowse.mini-tunnel)"; exit 1; }
echo "[cf-tunnel] public health OK at ${PUB}"

# 3. WITNESS: real data through the public tunnel.
body=$(curl -fsS --max-time 220 "${PUB}/search?intent=top%20stories%20on%20Hacker%20News" 2>/dev/null)
if [ -n "$body" ] && [ "${#body}" -gt 200 ] && printf '%s' "$body" | grep -q '"success":true'; then
  echo "[cf-tunnel] PASS — unbrowse is live at ${PUB} (real data, ${#body} bytes through the mac-mini tunnel)"
  exit 0
fi
echo "[cf-tunnel] FAIL: public /search returned no real data"; printf '%s\n' "${body:0:200}"; exit 1
