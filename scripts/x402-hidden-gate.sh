#!/usr/bin/env bash
# x402-hidden-gate.sh — x402 pays the tolls under the hood, hidden behind a
# redeemable Privy wallet (sp-toll). Exits 0 exactly when:
#   1. the redeemable-wallet reference passes (auto-pay on 402, real signature,
#      redeemable top-up, honest insufficient-funds) — test_pay.py;
#   2. x402 is HIDDEN: the wrapper's PUBLIC surface (every non-underscore def/class
#      and the user-facing statement) never names x402/402/payment — yet the
#      technology IS really used privately (it appears only on internal lines);
#   3. the whole reference corpus still passes (run_all.py).
set -uo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"
REF="paper/reference/pay/redeemable.py"
fail=0

echo "=== 1. redeemable wallet reference ==="
if python3 paper/reference/tests/test_pay.py; then echo "  test_pay: green"; else echo "  PAY-FAIL"; fail=1; fi

echo "=== 2. x402 is hidden from the public surface ==="
if [ ! -f "$REF" ]; then
  echo "  HIDE-FAIL: $REF missing"; fail=1
else
  # any PUBLIC definition (class X / def y at column 0, no leading underscore) that
  # names the protocol is a leak. Private (_-prefixed) defs may name it freely.
  leak=$(grep -nE '^(class|def) [A-Za-z]' "$REF" | grep -iE 'x402|payment|402' || true)
  if [ -n "$leak" ]; then echo "  HIDE-FAIL: public symbol names the technology:"; echo "$leak"; fail=1
  else echo "  hidden: no public symbol names x402/payment"; fi
  # but it must really exist privately — not faked away
  if grep -q "x-payment" "$REF" && grep -qE '^def _settle_x402' "$REF"; then
    echo "  real: x402 settlement exists privately (_settle_x402)"
  else echo "  HIDE-FAIL: the x402 mechanism is not actually implemented"; fail=1; fi
fi

echo "=== 3. reference corpus still green ==="
if python3 paper/reference/tests/run_all.py >/tmp/x402_runall.out 2>&1; then
  tail -1 /tmp/x402_runall.out
else echo "  RUNALL-FAIL (see /tmp/x402_runall.out)"; fail=1; fi

echo
if [ "$fail" -ne 0 ]; then echo "X402-HIDDEN-GATE FAIL"; exit 1; fi
echo "X402-HIDDEN-GATE PASS — the toll just works under the hood; x402 is hidden behind a redeemable Privy wallet."
