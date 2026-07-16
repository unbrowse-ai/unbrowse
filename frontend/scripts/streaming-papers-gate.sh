#!/usr/bin/env bash
# Witness for: the flagship-only papers surface + streaming chat.
# Only "Internal APIs Are All You Need" is published on unbrowse.ai; the companion
# PDFs were withdrawn from the site and archived off-repo. Exits 0 EXACTLY when:
#   PAPERS  1: /papers is driven by the single-source module and surfaces the flagship
#   STREAM  2: aiko-home chat reads an SSE token stream (stream:true + getReader + delta)
#   BUILD   3: typecheck clean
set -uo pipefail
cd "$(dirname "$0")/.." || exit 2
fail=0

chk() { # name, condition-cmd already evaluated to 0/1 via [ ]
  :; }

# 1. /papers surfaces the flagship paper (single source of truth in lib/papers.ts)
pp="src/app/papers/page.tsx"
if grep -q '@/lib/papers' "$pp" 2>/dev/null && grep -q 'internal-apis-are-all-you-need' src/lib/papers.ts 2>/dev/null; then
  echo "ok   gate: /papers surfaces the flagship paper via lib/papers"
else
  echo "FAIL gate: /papers no longer bound to lib/papers or flagship paper missing"; fail=1
fi

# 4. aiko-home streams (SSE token read)
ah="src/components/aiko-home.tsx"
if grep -q "stream: true" "$ah" && grep -q "getReader" "$ah" && grep -q "delta" "$ah"; then
  echo "ok   gate: aiko-home reads an SSE token stream"
else
  echo "FAIL gate: aiko-home not streaming (need stream:true + getReader + delta parsing)"; fail=1
fi

# 5. typecheck
if npx tsc --noEmit -p tsconfig.json >/tmp/sp-tsc.log 2>&1; then echo "ok   gate: tsc clean";
else echo "FAIL gate: tsc errors ($(grep -c 'error TS' /tmp/sp-tsc.log) found)"; fail=1; fi

[ "$fail" = "0" ] && echo "GATE GREEN" || echo "GATE RED"
exit $fail
