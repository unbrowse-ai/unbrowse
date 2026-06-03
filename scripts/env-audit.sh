#!/usr/bin/env bash
# env-audit — credential/config envs unbrowse needs; presence across .env,
# backend/.dev.vars, keychain. No values printed. Exit 0 iff CORE all present.
set -uo pipefail
cd "$(dirname "$0")/.."
where() { v="$1"
  grep -qE "^${v}=" .env 2>/dev/null && { echo "cli(.env)"; return; }
  grep -qE "^${v}=" backend/.dev.vars 2>/dev/null && { echo "worker(.dev.vars)"; return; }
  security find-generic-password -s "$v" -w >/dev/null 2>&1 && { echo "keychain"; return; }
  echo ""; }
miss=0
row() { p=$(where "$1"); if [ -n "$p" ]; then printf '  ok  %-34s %s\n' "$1" "$p"; else printf '  --  %-34s MISSING\n' "$1"; [ "${2:-}" = core ] && miss=$((miss+1)); fi; }
echo "== CORE (required to run) =="
for v in UNBROWSE_API_KEY EXA_API_KEY NEBIUS_API_KEY EMERGENTDB_API_KEY; do row "$v" core; done
echo "== PAYMENTS / x402 =="
for v in PAYMENT_RECIPIENT FLEX_PLATFORM_RECIPIENT_USDC_ATA STRIPE_SECRET_KEY PLATFORM_SPONSOR_WALLET_KEY IQ_SIGNER_SECRET_KEY PRIVY_APP_SECRET; do row "$v"; done
echo "== INFRA / PROD =="
for v in DATABASE_URL R2_ACCOUNT_ID R2_ACCESS_KEY_ID R2_SECRET_ACCESS_KEY SOLANA_RPC_URL CLOUDFLARE_API_TOKEN; do row "$v"; done
echo
[ "$miss" -eq 0 ] && { echo "[env-audit] PASS — all CORE envs present."; exit 0; }
echo "[env-audit] $miss CORE env(s) missing."; exit 1
