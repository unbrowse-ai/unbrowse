#!/usr/bin/env bash
# zk-invariant-gate.sh — the hole-descent-dag HARD INVARIANT, as a runnable witness:
# a hole's secret value is wallet-bound CLIENT-SIDE and never reaches unbrowse servers;
# only the commitment / proof crosses the wire. Plus AC-P0: attribution ids → commitment
# admitted by the publish gate (raw still rejected). No fabricated green.
set -uo pipefail
cd "$(dirname "$0")/.." || exit 2
fail=0
ok(){ printf 'ok   %s\n' "$1"; }
bad(){ printf 'FAIL %s\n' "$1"; fail=1; }

# AC-INV + AC-P0 client: ids → zkbind commitments, no raw id on the wire, admission predicate.
bun test tests/holeify-attribution.test.ts >/dev/null 2>&1 \
  && ok "AC-INV/P0 client: attribution ids → wallet-bound commitments (no raw id leaves)" \
  || bad "holeify-attribution.test.ts"

# AC-P0 backend: residual-secret gate admits the commitment, still flags the raw id.
( cd backend && bun test tests/zkbind-admission.test.ts >/dev/null 2>&1 ) \
  && ok "AC-P0 backend: detectResidualSecretLeak admits zkbind, rejects raw id" \
  || bad "zkbind-admission.test.ts"

# Parity: both looksLikeSecret copies stay byte-equivalent in behaviour.
( cd backend && bun test tests/sanitize-parity.test.ts >/dev/null 2>&1 ) \
  && ok "client↔backend sanitize parity holds (zkbind exception added to both)" \
  || bad "sanitize-parity.test.ts"

if [ "$fail" -eq 0 ]; then echo "ZK-INVARIANT GREEN — secrets are wallet-bound client-side; only commitments cross the wire"; exit 0; fi
echo "ZK-INVARIANT RED"; exit 1
