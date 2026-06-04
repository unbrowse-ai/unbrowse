#!/usr/bin/env bash
# pointer-cache-gate.sh — runnable witness for the covenant-learning / superpattern-shaped
# cache north star. Exits 0 EXACTLY when:
#   1. a pointer-dependent KV cache exists: content-addressed entries declare pointer deps;
#      changing a pointer's VALUE invalidates only its dependents (recompute), the rest stay
#      cached (fast) — docker-layer-style invalidation, but pointer-reactive;
#   2. entries are wallet-SEALED when auth is required (only the holder reveals) and PUBLIC
#      otherwise;
#   3. the wallet collects ALL auth/identity material (passwords, usernames, tokens, cookies,
#      headers, api keys), every secret sealed to the private key — only the holder reveals;
#   4. it is documented.
set -uo pipefail
cd "$(dirname "$0")/.."
fail=0

echo "== 1. pointer cache + auth-seal + auth-vault tests =="
bun test \
  tests/pointer-cache.test.ts \
  tests/pointer-cache-auth.test.ts \
  tests/auth-vault.test.ts || fail=1

echo "== 2. source files present =="
for f in src/values/pointer-cache.ts src/values/auth-vault.ts; do
  if [ ! -f "$f" ]; then echo "  MISSING $f"; fail=1; fi
done

echo "== 3. docs cover pointer-dependent caching + wallet sealing + auth vault =="
for term in "pointer" "recompute" "wallet" "auth"; do
  if ! grep -qi "$term" docs/caching.md 2>/dev/null; then echo "  docs/caching.md missing: $term"; fail=1; fi
done

echo "== 4. no moat leak in new public docs =="
bash scripts/leak-guard.sh docs/caching.md >/dev/null 2>&1 || { echo "  leak-guard FAIL on docs/caching.md"; fail=1; }

if [ "$fail" -eq 0 ]; then
  echo "POINTER_CACHE_GATE PASS — pointer-reactive KV cache, wallet-or-public sealing, auth vault — tested + documented."
else
  echo "POINTER_CACHE_GATE FAIL — see items above."
fi
exit $fail
