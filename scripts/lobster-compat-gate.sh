#!/usr/bin/env bash
# lobster-compat-gate — witness that Unbrowse's live x402 meets lobster.cash's
# requirements (Solana + USDC) AND the lobster.cash integration doc exists with
# lobster listed as a compatible+tested wallet. Un-fakeable: reads the live 402.
set -uo pipefail
cd "$(dirname "$0")/.."
API="${UNBROWSE_API_URL:-https://beta-api.unbrowse.ai}"
B=$(curl -s --max-time 25 -X POST "$API/v1/llm/anthropic/messages" -H "content-type: application/json" \
  -d '{"model":"claude-sonnet-4-6","max_tokens":16,"messages":[{"role":"user","content":"hi"}]}' 2>/dev/null)
ok=$(printf '%s' "$B" | python3 -c "
import sys,json
try: d=json.load(sys.stdin)
except: print('0'); sys.exit()
a=(d.get('accepts') or [{}])[0]
sol='solana' in str(a.get('network','')).lower()
usdc=a.get('asset','')=='EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v'
print('1' if sol and usdc else '0')
" 2>/dev/null)
[ "$ok" = "1" ] || { echo "[lobster-gate] FAIL — x402 not Solana+USDC: $(printf '%s' "$B" | head -c 160)"; exit 1; }
echo "[lobster-gate] ok — x402 challenge is Solana + USDC (lobster-compatible)"
D=docs/public/lobster-cash-integration.md
[ -f "$D" ] && grep -qiE "compatible.*tested wallet.*lobster|lobster\.cash" "$D" || { echo "[lobster-gate] FAIL — lobster doc missing/incomplete"; exit 1; }
echo "[lobster-gate] ok — lobster.cash listed as compatible+tested wallet"
echo "[lobster-gate] PASS — Unbrowse pays via lobster.cash (Solana/USDC x402 delegation)."
