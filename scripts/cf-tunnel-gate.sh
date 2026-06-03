#!/usr/bin/env bash
# cf-tunnel-gate — witness AND launcher for "local unbrowse, exposed via a Cloudflare
# Tunnel." Idempotent: starts the local shim + a cloudflared quick tunnel if not
# already up, then proves the public URL serves real unbrowse data. Exit 0 iff a curl
# of the PUBLIC tunnel URL returns live unbrowse content (mac-mini unbrowse, no Worker
# deploy). Uses a quick (*.trycloudflare.com) tunnel so the live named tunnels are
# untouched.
set -uo pipefail
cd "$(dirname "$0")/.."
set -a; . ./.env 2>/dev/null || true; set +a
PORT="${UNBROWSE_SHIM_PORT:-8799}"
URLF=/tmp/unbrowse-cf-tunnel.url
SHIM_LOG=/tmp/unbrowse-shim.log
TUN_LOG=/tmp/unbrowse-cftunnel.log

# 1. local shim up?
if ! curl -fsS "http://127.0.0.1:${PORT}/health" >/dev/null 2>&1; then
  echo "[cf-tunnel] starting local unbrowse shim on :${PORT}"
  UNBROWSE_SHIM_PORT="$PORT" nohup python3 scripts/unbrowse-http-shim.py >"$SHIM_LOG" 2>&1 &
  for _ in $(seq 1 20); do curl -fsS "http://127.0.0.1:${PORT}/health" >/dev/null 2>&1 && break; sleep 0.5; done
fi
curl -fsS "http://127.0.0.1:${PORT}/health" >/dev/null 2>&1 || { echo "[cf-tunnel] FAIL: local shim not healthy"; tail -3 "$SHIM_LOG" 2>/dev/null; exit 1; }
echo "[cf-tunnel] local shim healthy on :${PORT}"

# 2. quick tunnel up? (reuse the URL if the tunnel process is alive)
if ! pgrep -f "cloudflared.*tunnel.*--url.*${PORT}" >/dev/null 2>&1; then
  echo "[cf-tunnel] starting cloudflared quick tunnel -> :${PORT}"
  nohup cloudflared tunnel --url "http://127.0.0.1:${PORT}" >"$TUN_LOG" 2>&1 &
  : > "$URLF"
  for _ in $(seq 1 40); do
    u=$(grep -oE 'https://[a-z0-9-]+\.trycloudflare\.com' "$TUN_LOG" 2>/dev/null | head -1)
    [ -n "$u" ] && { echo "$u" > "$URLF"; break; }
    sleep 1
  done
fi
PUB=$(cat "$URLF" 2>/dev/null)
[ -n "$PUB" ] || { echo "[cf-tunnel] FAIL: no public tunnel URL yet"; tail -5 "$TUN_LOG" 2>/dev/null; exit 1; }
echo "[cf-tunnel] public URL: $PUB"

# 3. WITNESS: the public URL serves real unbrowse data.
#
#    Resolution note: this host's getaddrinfo can fail on *.trycloudflare.com
#    under Tailscale MagicDNS split-DNS even though the record is globally valid
#    (dig/host against 1.1.1.1/8.8.8.8 resolve it, and a remote consumer resolves
#    it fine). So if plain curl can't resolve the name, pin the REAL Cloudflare
#    edge IP from a public resolver and retry. The request still traverses the
#    public internet to Cloudflare's edge with the real SNI/Host — only the
#    broken local lookup is bypassed, never the public path.
PUBHOST=$(printf '%s' "$PUB" | sed -E 's#^https?://##; s#/.*##')
EDGE_IP=""
resolve_edge() {
  EDGE_IP=$(dig +short "$PUBHOST" @1.1.1.1 2>/dev/null | grep -E '^[0-9]+\.' | head -1)
  [ -z "$EDGE_IP" ] && EDGE_IP=$(dig +short "$PUBHOST" @8.8.8.8 2>/dev/null | grep -E '^[0-9]+\.' | head -1)
  [ -z "$EDGE_IP" ] && EDGE_IP=$(host "$PUBHOST" 2>/dev/null | awk '/has address/{print $4; exit}')
}
# curl the public URL; transparently pin the edge IP when getaddrinfo is broken.
pub_curl() {
  local path="$1"; shift
  if [ -n "$EDGE_IP" ]; then
    curl --resolve "${PUBHOST}:443:${EDGE_IP}" "$@" "${PUB}${path}"
  else
    curl "$@" "${PUB}${path}"
  fi
}

# Resolve the real edge IP up front so BOTH /health and /search use a consistent
# path. getaddrinfo on this host is unreliable for *.trycloudflare.com, so we do
# not depend on it: pin the public edge from a real public-resolver answer.
resolve_edge
ready=0
for i in $(seq 1 30); do
  pub_curl "/health" -fsS --max-time 15 2>/dev/null | grep -qE '"ok": *true' && { ready=1; break; }
  # Re-resolve in case the first public-resolver query was empty (propagation lag).
  [ -z "$EDGE_IP" ] && resolve_edge
  sleep 2
done
[ "$ready" -eq 1 ] || { echo "[cf-tunnel] FAIL: public /health never returned ok (edge not connected)"; exit 1; }
body=$(pub_curl "/search?intent=top%20stories%20on%20Hacker%20News" -fsS --max-time 200 2>/dev/null)
if [ -n "$body" ] && [ "${#body}" -gt 80 ] && ! printf '%s' "$body" | grep -qiE '"error"'; then
  via=$([ -n "$EDGE_IP" ] && echo " via edge $EDGE_IP" || echo "")
  echo "[cf-tunnel] PASS — local unbrowse is live at $PUB (real data, ${#body} bytes over the tunnel${via})"
  exit 0
fi
echo "[cf-tunnel] FAIL: public /search returned no real data"; printf '%s\n' "${body:0:200}"; exit 1
