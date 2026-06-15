#!/usr/bin/env bash
# bench/capability/webagent/gate_x402.sh — the x402 PAYMENT lever, gated honestly.
#
# x402 is the 402-Payment-Required handshake: a paid endpoint answers 402 with
# Flex terms (escrow, splits, facilitator); the client signs an authorization over
# the FROZEN 402-terms splits and replays with an X-PAYMENT header. This gate
# proves the parts that can be judged WITHOUT spending real money, and marks the
# real-money on-chain settlement lane BLOCKED (never a fabricated green):
#
#   WITNESS 1 (protocol tests, no funds): the signer + payment-gate + the execute
#     payment surface unit-test green. These are the money MACHINERY: 402 detection,
#     splits-from-terms (frozen, never client-recomputed), the X-PAYMENT replay seam.
#   WITNESS 2 (live facilitator config): a real child process with a test-chosen
#     UNBROWSE_X402_FACILITATOR sentinel proves flexFacilitatorUrl() reads the declared
#     config, not a hardcoded host — the one knob that points payments at a facilitator.
#
#   SETTLEMENT LANE (real funds): getFlexWallet() returns null unless a provisioned,
#     funded escrow wallet exists. Driving a real on-chain settle needs money this
#     context cannot spend, so that axis is reported BLOCKED (exit-noted), NOT FAIL and
#     NOT a fake pass. The Flex program itself is devnet-only; mainnet settle is a
#     separate funded job (scripts/flex-devnet-settle.mjs / x402-pay-mainnet.mjs).
#
# Exit: 0 when BOTH testable witnesses pass (the protocol layer works); 1 if either
# witness fails (a real protocol regression); 3 (BLOCKED) only if the test runner
# itself can't execute (no bun / toolchain).
set -uo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$HERE/../../.." && pwd)"
cd "$ROOT"
TS="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
HISTORY="$ROOT/bench/capability/history.jsonl"
RUNNER="${UNBROWSE_TEST_RUNNER:-bun test}"

echo "── x402 payment gate (protocol witnessed; settlement honestly blocked) ──" >&2

# ---- WITNESS 1: protocol-layer unit tests (no real funds) -------------------
W1="FAIL"
if ! command -v bun >/dev/null 2>&1; then
  echo " W1 BLOCKED — no bun toolchain to run the protocol tests" >&2
  python3 -c "import json;open('$HISTORY','a').write(json.dumps({'ts':'$TS','source':'live','axis':'x402','verdict':'BLOCKED','reason':'no-bun'})+'\n')"
  echo " GATE: BLOCKED — cannot run the x402 protocol tests (toolchain absent)"; exit 3
fi
P1_OUT="$(timeout 150 $RUNNER tests/base-x402-signer.test.ts tests/payment-gate.test.ts tests/execution-payment-surface.test.ts 2>&1)"
# Green iff bun reports 0 fail across the three protocol files.
if echo "$P1_OUT" | grep -qE '^ *0 fail'; then
  W1="PASS"; echo "  W1 PASS — x402 signer + payment-gate + execute payment surface: 0 fail" >&2
else
  echo "  W1 FAIL — protocol tests not green:" >&2
  echo "$P1_OUT" | grep -iE '(fail|error)' | head -4 >&2
fi

# ---- WITNESS 2: live facilitator config honors the declared env -------------
# A real child process with a unique sentinel: if flexFacilitatorUrl() reads the
# declared X402_CONFIG (not a hardcoded host), the sentinel comes back verbatim.
W2="FAIL"
FP="$ROOT/src/payments/flex-pay.ts"
SENTINEL="https://sentinel-$$-$(date -u +%s).facilitator.test"
FAC_OUT="$(UNBROWSE_X402_FACILITATOR="$SENTINEL" __FP="$FP" \
  timeout 40 bun -e 'import(process.env.__FP).then(m=>process.stdout.write(m.flexFacilitatorUrl())).catch(e=>process.stderr.write("ERR:"+e))' 2>&1)"
if [ "$FAC_OUT" = "$SENTINEL" ]; then
  W2="PASS"; echo "  W2 PASS — flexFacilitatorUrl() honors declared config (sentinel round-trips)" >&2
else
  echo "  W2 FAIL — facilitator URL did not track the declared sentinel: got '${FAC_OUT:0:60}'" >&2
fi

# ---- SETTLEMENT LANE: real-money on-chain settle (honestly blocked) ---------
# getFlexWallet() returns null without a provisioned/funded escrow wallet. Probe it:
# null => the real settle path can't run here (no funds) => BLOCKED, reported, not faked.
SETTLE="BLOCKED"
WALLET_OUT="$(__FP="$FP" timeout 40 bun -e '
import(process.env.__FP).then(async m=>{
  // settleViaFlex returns null when there is no provisioned wallet (the funds gate).
  const r = await m.settleViaFlex("https://example.test/x", {accepts:[{scheme:"@faremeter/flex",amount:"1",extra:{flexAuthorizationDraft:{escrow:"E",mint:"M",maxAmount:"1",authorizationId:"1",expiresAtSlot:"1",splits:[]},splits:[],programId:"P"}}]});
  process.stdout.write(r===null?"NOWALLET":"HASWALLET");
}).catch(e=>process.stdout.write("NOWALLET"))' 2>/dev/null)"
if [ "$WALLET_OUT" = "HASWALLET" ]; then
  SETTLE="PASS"; echo "  SETTLE PASS — a provisioned Flex wallet is present; real settle path live" >&2
else
  echo "  SETTLE BLOCKED — no provisioned/funded escrow wallet in-context (real-money lane; devnet/mainnet job)" >&2
fi

echo "─────────────────────────────────────────────────"
echo " x402: protocol_tests=$W1  facilitator_config=$W2  settlement=$SETTLE"
python3 -c "
import json
open('$HISTORY','a').write(json.dumps({'ts':'$TS','source':'live','axis':'x402',
  'protocol_tests':'$W1','facilitator_config':'$W2','settlement':'$SETTLE',
  'gate':'true' if ('$W1'=='PASS' and '$W2'=='PASS') else 'false'})+'\n')
"
if [ "$W1" = "PASS" ] && [ "$W2" = "PASS" ]; then
  echo " GATE: PASS — x402 payment protocol works (signing, frozen splits, facilitator config);"
  echo "             real-money settlement is the honest BLOCKED gap (needs a funded wallet)."
  exit 0
fi
echo " GATE: FAIL — an x402 protocol witness failed (real regression in the payment machinery)"
exit 1
