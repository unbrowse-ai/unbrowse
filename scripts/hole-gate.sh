#!/usr/bin/env bash
# hole-gate.sh — the runnable witness for the "wallet-sealed hole + drop-in adapters"
# north star. Exits 0 EXACTLY when:
#   1. the single streaming "hole" + the three drop-in adapters + the wallet seal exist
#      and their hermetic shape-tests pass (drop-in == same call shape, same response shape);
#   2. the source files are present;
#   3. README + docs/adapters.md document the hole and the adapters.
# Hermetic: the adapter tests inject a stub transport — no network, deterministic.
set -uo pipefail
cd "$(dirname "$0")/.."
fail=0

echo "== 1. hole + adapter + wallet-seal shape tests =="
bun test \
  tests/sdk-hole.test.ts \
  tests/adapter-exa.test.ts \
  tests/adapter-tavily.test.ts \
  tests/adapter-browser-use.test.ts \
  tests/hole-wallet-seal.test.ts || fail=1

echo "== 2. source files present =="
for f in \
  src/sdk/hole.ts \
  src/sdk/adapters/exa.ts \
  src/sdk/adapters/tavily.ts \
  src/sdk/adapters/browser-use.ts \
  src/sdk/adapters/index.ts; do
  if [ ! -f "$f" ]; then echo "  MISSING $f"; fail=1; fi
done

echo "== 3. docs present + cover the hole and adapters =="
if [ ! -f docs/adapters.md ]; then echo "  MISSING docs/adapters.md"; fail=1; fi
if ! grep -qiE "drop-in|hole" README.md 2>/dev/null; then echo "  README missing hole/adapter section"; fail=1; fi
for term in exa tavily browser-use; do
  if ! grep -qi "$term" docs/adapters.md 2>/dev/null; then echo "  docs/adapters.md missing $term"; fail=1; fi
done

if [ "$fail" -eq 0 ]; then
  echo "HOLE_GATE PASS — wallet-sealed hole + exa/tavily/browser-use drop-ins, tested + documented."
else
  echo "HOLE_GATE FAIL — see missing/red items above."
fi
exit $fail
