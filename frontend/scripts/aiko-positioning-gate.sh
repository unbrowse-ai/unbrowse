#!/usr/bin/env bash
# aiko-positioning-gate.sh — runnable witness for the lewis-brain positioning re-lead.
# Exits 0 ONLY when the LIVE prod /aiko page leads on the context-inversion frame
# ("she already knows how you work / Aiko IS your context"), carries the pillars,
# is jargon-clean in visible copy, and the live checkout still mints a cs_live_ session.
# No local optimism: it grades the deployed artifact at www.unbrowse.ai.
set -uo pipefail

URL="${AIKO_URL:-https://www.unbrowse.ai/aiko}"
CHECKOUT="${AIKO_CHECKOUT:-https://www.unbrowse.ai/api/aiko-checkout}"
HTML="$(curl -s "$URL")"
# strip <script>…</script> so RSC/JSON payload words don't count as visible copy
BODY="$(printf '%s' "$HTML" | perl -0777 -pe 's/<script.*?<\/script>//gs')"

fail=0
have() { case "$BODY" in *"$1"*) ;; *) echo "  MISS: $2 — expected substring: $1"; fail=1;; esac; }
absent() { case "$BODY" in *"$1"*) echo "  BANNED present in visible copy: $1 ($2)"; fail=1;; *) ;; esac; }

echo "== positioning lead (context inversion) =="
# at least the inversion headline must be present (any one of these phrasings)
case "$BODY" in
  *"already knows how you work"*|*"already has your context"*|*"Aiko is the context"*|*"Aiko is your context"*)
    echo "  OK: context-inversion headline present";;
  *) echo "  MISS: no context-inversion headline (need 'already knows how you work' / 'already has your context' / 'Aiko is the/your context')"; fail=1;;
esac

echo "== four pillars (user-moments) =="
have "context" "pillar 1 — she has your context"
have "learns" "pillar 2 — she understands/learns you"
have "does the work" "pillar 3 — she does it, not describes it"
have "your Mac" "pillar 4 — on your Mac / nothing leaves"

echo "== offer intact =="
have "100" "early-bird \$100"
have "200" "anchor \$200"
have "50%" "50% off"
have "Subscribe early" "subscribe CTA"

echo "== jargon-clean (RULE B — banned in visible copy) =="
for t in " MCP " " x402 " " CLI " "API key" " agent " " agents " "headless browser" "route graph" "model id"; do
  absent "$t" "implementation jargon"
done

echo "== live checkout still works =="
CS="$(curl -s -X POST "$CHECKOUT")"
case "$CS" in *cs_live_*) echo "  OK: cs_live_ session";; *) echo "  MISS: checkout not returning cs_live_ ($CS)"; fail=1;; esac

if [ "$fail" -eq 0 ]; then
  echo "GATE: PASS — live /aiko leads on the witnessed positioning, jargon-clean, checkout live."
  exit 0
fi
echo "GATE: FAIL"
exit 1
