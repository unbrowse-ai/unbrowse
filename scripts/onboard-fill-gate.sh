#!/usr/bin/env bash
# onboard-fill-gate.sh — runnable witness for the onboarding + acting/auto-indexing +
# client-side-LLM north star. Exits 0 EXACTLY when:
#   1. identity onboarding resolves in best-practice order (bound account via api key,
#      else the auto-created local self-custody wallet) and reports a next step;
#   2. `fill` can ACT (not just read) and AUTO-INDEXES a captured route via an injectable
#      index hook (the discover→publish loop), toggleable;
#   3. the "index it nicely" LLM generation runs CLIENT-SIDE via a pluggable generate hook
#      (the agent's own model), never a server round-trip;
#   4. it is documented.
# Hermetic: every hook (transport, index, generate, api-key/wallet resolvers) is injected.
set -uo pipefail
cd "$(dirname "$0")/.."
fail=0

echo "== 1. onboarding + acting/auto-index + client-llm tests =="
bun test \
  tests/sdk-onboard.test.ts \
  tests/fill-act-autoindex.test.ts \
  tests/client-llm-generation.test.ts || fail=1

echo "== 2. source files present =="
for f in src/sdk/onboard.ts src/sdk/hole.ts; do
  if [ ! -f "$f" ]; then echo "  MISSING $f"; fail=1; fi
done

echo "== 3. docs cover onboarding + act + auto-index + client-side llm =="
for term in onboard "auto-index" act "client-side"; do
  if ! grep -qi "$term" docs/onboarding.md 2>/dev/null; then echo "  docs/onboarding.md missing: $term"; fail=1; fi
done

if [ "$fail" -eq 0 ]; then
  echo "ONBOARD_FILL_GATE PASS — identity onboarding + fill-acts-and-auto-indexes + client-side LLM, tested + documented."
else
  echo "ONBOARD_FILL_GATE FAIL — see items above."
fi
exit $fail
