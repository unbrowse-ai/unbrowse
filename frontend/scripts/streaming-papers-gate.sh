#!/usr/bin/env bash
# Witness for: "add streaming + include the other two papers on the frontend".
# Exits 0 EXACTLY when both are done:
#   PAPERS  1-3: both other papers' PDFs in public/ and all three listed on /papers
#   STREAM  4:   aiko-home chat reads an SSE token stream (stream:true + getReader + delta)
#   BUILD   5:   typecheck clean
set -uo pipefail
cd "$(dirname "$0")/.." || exit 2
fail=0

chk() { # name, condition-cmd already evaluated to 0/1 via [ ]
  :; }

# 1-2. PDFs present
for p in crypto-was-all-you-needed internal-apis-were-not-all-you-needed; do
  if [ -f "public/$p.pdf" ]; then echo "ok   gate: public/$p.pdf present";
  else echo "FAIL gate: public/$p.pdf missing"; fail=1; fi
done

# 3. /papers lists all three (the two new hrefs)
pp="src/app/papers/page.tsx"
miss=""
for h in crypto-was-all-you-needed internal-apis-were-not-all-you-needed internal-apis-are-all-you-need; do
  grep -q "$h" "$pp" 2>/dev/null || miss="$miss $h"
done
if [ -z "$miss" ]; then echo "ok   gate: /papers lists all three papers"; else echo "FAIL gate: /papers missing:$miss"; fail=1; fi

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
