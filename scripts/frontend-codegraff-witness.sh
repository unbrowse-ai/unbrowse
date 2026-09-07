#!/usr/bin/env bash
# End-to-end witness: frontend hero-chat is pinned to Codegraff deepseek-v4-flash.
# Exit 0 only when code pins + CF secret + live provider chat all hold.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"
fail() { echo "FAIL: $*" >&2; exit 1; }

# 1) Code pins (no Nebius tokenfactory URL as default)
rg -q 'gateway\.codegraff\.com/v1/chat/completions' frontend/src/lib/hero-tools.ts \
  || fail "hero-tools missing Codegraff LLM_URL"
rg -q 'deepseek-v4-flash' frontend/src/lib/hero-tools.ts \
  || fail "hero-tools missing deepseek-v4-flash"
! rg -q 'api\.tokenfactory\.nebius\.com' frontend/src/lib/hero-tools.ts \
  || fail "hero-tools still points at Nebius tokenfactory"

# 2) Routes use LLM_URL + CODEGRAFF_API_KEY
rg -q 'LLM_URL' frontend/src/app/api/hero-chat/route.ts \
  frontend/src/app/api/hero-chat/step/route.ts \
  || fail "hero-chat routes not on LLM_URL"
rg -q 'CODEGRAFF_API_KEY' frontend/src/app/api/hero-chat/route.ts \
  frontend/src/app/api/hero-chat/step/route.ts \
  || fail "hero-chat routes missing CODEGRAFF_API_KEY"

# 3) Cloudflare secret present on frontend worker
(cd frontend && npx wrangler secret list 2>/dev/null) | rg -q 'CODEGRAFF_API_KEY' \
  || fail "CODEGRAFF_API_KEY not listed on frontend worker secrets"

# 4) Live Codegraff provider (key from env; never print it)
KEY="${CODEGRAFF_API_KEY:-}"
if [[ -z "$KEY" ]]; then
  # Prefer a local non-committed file if present
  if [[ -f "$HOME/.config/unbrowse/codegraff.key" ]]; then
    KEY="$(tr -d '[:space:]' <"$HOME/.config/unbrowse/codegraff.key")"
  fi
fi
[[ -n "$KEY" ]] || fail "CODEGRAFF_API_KEY not in env (needed for live chat smoke)"

HTTP=$(curl -sS -o /tmp/cg-witness-chat.json -w '%{http_code}' \
  https://gateway.codegraff.com/v1/chat/completions \
  -H "Authorization: Bearer ${KEY}" \
  -H "Content-Type: application/json" \
  -d '{"model":"deepseek-v4-flash","messages":[{"role":"user","content":"reply with the single word pong"}],"max_tokens":16,"temperature":0}' \
  --max-time 30) || fail "curl to Codegraff failed"
[[ "$HTTP" == "200" ]] || fail "Codegraff chat HTTP $HTTP: $(head -c 200 /tmp/cg-witness-chat.json)"
rg -q '"content"' /tmp/cg-witness-chat.json || fail "Codegraff response missing content"

echo "OK: frontend hero LLM = Codegraff deepseek-v4-flash (code + secret + live chat)"
exit 0
