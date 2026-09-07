#!/usr/bin/env bash
# stack-health-gate — witness that the whole stack works down to auth + creds:
# CORE envs present, auth key authenticates prod, EmergentDB (vectors+KV) live,
# x402/lobster payment path live (Solana/USDC), Helius RPC healthy. Un-fakeable
# (real network + real key). Exit 0 only when every leg is green.
set -uo pipefail
cd "$(dirname "$0")/.."
set -a; . ./.env 2>/dev/null || true; set +a
fail=0; ok(){ printf '  ok  %s\n' "$1"; }; bad(){ printf '  --  %s\n' "$1"; fail=1; }
API="${UNBROWSE_API_URL:-https://beta-api.unbrowse.ai}"

echo "[1] CORE envs"; bash scripts/env-audit.sh >/dev/null 2>&1 && ok "env-audit CORE present" || bad "env-audit CORE missing"
echo "[2] auth creds"; c=$(curl -s -o /dev/null -w '%{http_code}' --max-time 12 -H "Authorization: Bearer ${UNBROWSE_API_KEY:-}" "$API/v1/account/sponsor-status" 2>/dev/null); [ "$c" = 200 ] && ok "UNBROWSE_API_KEY authenticates (sponsor-status 200)" || bad "auth failed ($c)"
echo "[3] EmergentDB substrate"; bash scripts/emergentdb-gate.sh >/dev/null 2>&1 && ok "EmergentDB vectors+KV live" || bad "EmergentDB down"
echo "[4] payment path"; bash scripts/lobster-compat-gate.sh >/dev/null 2>&1 && ok "x402/lobster Solana+USDC live" || bad "payment path broken"
echo "[5] Helius RPC"; h=$(curl -s --max-time 12 "${SOLANA_RPC_URL:-x}" -X POST -H 'content-type: application/json' -d '{"jsonrpc":"2.0","id":1,"method":"getHealth"}' 2>/dev/null); echo "$h" | grep -q '"result":"ok"' && ok "Helius RPC healthy" || bad "Helius RPC unhealthy"
echo; [ "$fail" -eq 0 ] && { echo "[stack-health] PASS — auth, envs, substrate, payments, RPC all green."; exit 0; }
echo "[stack-health] NOT YET — a leg is down (see above)."; exit 1
