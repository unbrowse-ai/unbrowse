#!/usr/bin/env bash
# pay-sh-gate — two-witness gate for pay.sh support in the unbrowse skill +
# client layers. Exit 0 ONLY when BOTH witnesses pass; exit 1 on any failure.
# No fabricated green. No real funds move (sandbox = ephemeral localnet wallet).
#
#   Witness A — unit (offline, deterministic):
#     bun test tests/pay-sh.test.ts tests/pay-sh-skill.test.ts
#       - client layer: adapter selection, request marshaling, cost ceiling,
#         pay_no_binary; `pay` stubbed via PATH shim.
#       - skill layer: pay_provider field, resolve labeling, observation->descriptor,
#         flagged catalog discovery (default-off).
#
#   Witness B — live sandbox handshake (real protocol), two sub-checks on one
#   `pay --sandbox server demo` gateway, torn down after:
#     B1 library — unbrowse's real x402Fetch through the pay adapter → paid 200.
#     B2 CLI     — the real `unbrowse fetch <url>` binary pays the MPP 402 → 200
#                  body, `pay_signed` in the trace. This is the user-facing surface.
#
# The two witnesses cannot share a failure mode: A never touches the network,
# B never touches a stub.

set -uo pipefail
cd "$(dirname "$0")/.." || exit 2

fail=0
PORT=1402
DEMO_URL="http://127.0.0.1:${PORT}/api/v1/reports/usage"
GW_PID=""
GW_WORKDIR=""

pass() { printf '  \033[32m✓\033[0m %s\n' "$1"; }
bad()  { printf '  \033[31m✗\033[0m %s\n' "$1"; fail=1; }

cleanup() {
  if [ -n "$GW_PID" ]; then
    kill "$GW_PID" 2>/dev/null || true
    # pay may spawn children; sweep by command line as a backstop.
    pkill -f "pay --sandbox server demo" 2>/dev/null || true
    wait "$GW_PID" 2>/dev/null || true
  fi
  [ -n "$GW_WORKDIR" ] && rm -rf "$GW_WORKDIR" 2>/dev/null || true
}
trap cleanup EXIT

echo "── pay.sh gate ──────────────────────────────────────────"

# ── Witness A — unit ─────────────────────────────────────────────────────────
echo "Witness A: unit (client + skill layer)"
if bun test tests/pay-sh.test.ts tests/pay-sh-skill.test.ts >/tmp/pay-sh-unit.log 2>&1; then
  pass "unit witness green"
else
  bad "unit witness FAILED — see /tmp/pay-sh-unit.log"
  tail -20 /tmp/pay-sh-unit.log
fi

# ── Witness B — live sandbox handshake ───────────────────────────────────────
echo "Witness B: live pay --sandbox handshake"

if ! command -v pay >/dev/null 2>&1; then
  bad "pay CLI not on PATH — cannot run the live witness (install: https://pay.sh)"
else
  # Free the port if a stray gateway is holding it.
  pkill -f "pay --sandbox server demo" 2>/dev/null || true
  sleep 1

  GW_WORKDIR="$(mktemp -d "${TMPDIR:-/tmp}/pay-demo.XXXXXX")"
  ( cd "$GW_WORKDIR" && exec pay --sandbox server demo ) >/tmp/pay-sh-gateway.log 2>&1 &
  GW_PID=$!

  # Poll the gateway up to ~30s; the unpaid endpoint must answer 402.
  up=0
  for _ in $(seq 1 30); do
    code="$(curl -s -o /dev/null -w '%{http_code}' --max-time 2 "$DEMO_URL" 2>/dev/null || echo 000)"
    if [ "$code" = "402" ]; then up=1; break; fi
    # If the gateway process died, stop waiting.
    if ! kill -0 "$GW_PID" 2>/dev/null; then break; fi
    sleep 1
  done

  if [ "$up" != "1" ]; then
    bad "sandbox gateway never reached a 402 on $DEMO_URL — see /tmp/pay-sh-gateway.log"
    tail -20 /tmp/pay-sh-gateway.log
  else
    # B1 — library path: unbrowse's real x402Fetch through the pay adapter.
    if PAY_DEMO_URL="$DEMO_URL" UNBROWSE_PAY_SANDBOX=1 \
        bun scripts/pay-sh-e2e.ts >/tmp/pay-sh-e2e.log 2>&1; then
      pass "B1 library (x402Fetch): $(tail -1 /tmp/pay-sh-e2e.log)"
    else
      bad "B1 library witness FAILED — see /tmp/pay-sh-e2e.log"
      tail -20 /tmp/pay-sh-e2e.log
    fi

    # B2 — CLI path: the real `unbrowse fetch <url>` binary pays the 402.
    cli_out="$(UNBROWSE_WALLET_ADAPTER=pay UNBROWSE_PAY_SANDBOX=1 \
      bin/unbrowse-dev fetch "$DEMO_URL" 2>/tmp/pay-sh-cli.err)"
    cli_rc=$?
    if [ "$cli_rc" -eq 0 ] \
        && printf '%s' "$cli_out" | grep -q '"status":"ok"' \
        && grep -q 'pay_signed' /tmp/pay-sh-cli.err; then
      pass "B2 CLI (unbrowse fetch): paid 402 → 200, body=$cli_out"
    else
      bad "B2 CLI witness FAILED (rc=$cli_rc) — stdout: $cli_out"
      tail -10 /tmp/pay-sh-cli.err
    fi
  fi
fi

echo "─────────────────────────────────────────────────────────"
if [ "$fail" -ne 0 ]; then
  echo "GATE FAIL"
  exit 1
fi
echo "GATE PASS (two witnesses green, no real funds)"
exit 0
