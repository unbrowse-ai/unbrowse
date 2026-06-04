#!/usr/bin/env bash
# ows-gate.sh — runnable witness for adopting the Open Wallet Standard (OWS) as the
# primary wallet path. Exits 0 EXACTLY when:
#   1. the OWS policy engine + provider resolution tests pass (CAIP types, declarative
#      allowed_chains/expires_at AND-combined, vault descriptor resolution);
#   2. OWS is PREFERRED over lobster.cash in the wallet context;
#   3. the existing lobster/payment wallet tests still pass (no regression);
#   4. it is documented.
set -uo pipefail
cd "$(dirname "$0")/.."
fail=0

echo "== 1. OWS policy + provider tests =="
bun test tests/ows-policy.test.ts tests/ows-provider.test.ts || fail=1

echo "== 2. no wallet-context regression (lobster/payment paths) =="
bun test tests/lobster-payments.test.ts tests/payment-gate.test.ts || fail=1

echo "== 3. source present =="
[ -f src/payments/ows.ts ] || { echo "  MISSING src/payments/ows.ts"; fail=1; }

echo "== 4. documented + no moat leak =="
for term in "open wallet standard" "policy" "lobster"; do
  if ! grep -qi "$term" docs/ows.md 2>/dev/null; then echo "  docs/ows.md missing: $term"; fail=1; fi
done
bash scripts/leak-guard.sh docs/ows.md >/dev/null 2>&1 || { echo "  leak-guard FAIL on docs/ows.md"; fail=1; }

if [ "$fail" -eq 0 ]; then
  echo "OWS_GATE PASS — OWS provider + policy engine, preferred over lobster, no regression, documented."
else
  echo "OWS_GATE FAIL — see items above."
fi
exit $fail
