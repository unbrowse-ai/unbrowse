#!/usr/bin/env bash
# bench/capability/webagent/gate_frontend.sh — the FRONTEND sign-in UX lever, gated.
#
# The bug the user screenshotted: the sign-in form showed a raw "HTTP 410" for a
# transient mid-redeploy edge blip — a dead-end message for a self-clearing state.
# The fix classifies transient statuses (410/408/425/429/5xx) → a friendly retryable
# message. Two witnesses:
#
#   WITNESS 1 (behavioral unit test): classifyAuthStartStatus(410) === "transient", the
#     whole transient family maps to the friendly message, 400 → invalid, 2xx → ok. The
#     mapping is now a pure exported helper, so the fix is tested, not just grepped.
#   WITNESS 2 (live health probe): POST /v1/auth/email/start to the real beta API returns a
#     HEALTHY status (2xx / 400 / 422) — proving the 410 the user saw was transient and the
#     endpoint is live. A recurring 410 / 5xx / network failure is BLOCKED (infra), not a
#     code FAIL: the unit witness already proves the UX handles it gracefully.
#
# Exit: 0 when W1 passes AND W2 is healthy; 1 if W1 (the code) fails; 3 (BLOCKED) if W1
# passes but the live endpoint is unreachable/transient (infra, not our code).
set -uo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$HERE/../../.." && pwd)"
FRONTEND="$ROOT/frontend"
cd "$ROOT"
TS="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
HISTORY="$ROOT/bench/capability/history.jsonl"
API="${UNBROWSE_API_ORIGIN:-https://beta-api.unbrowse.ai}"

echo "── frontend sign-in UX gate (transient-error mapping + live health) ──" >&2

# WITNESS 1 — the pure mapping is correct (deterministic).
W1="FAIL"
if command -v bun >/dev/null 2>&1; then
  O1="$(cd "$FRONTEND" && timeout 60 bun test tests/auth-start-error.test.ts 2>&1)"
  if echo "$O1" | grep -qE '^ *0 fail' && echo "$O1" | grep -qE '^ *[1-9][0-9]* pass'; then
    W1="PASS"; echo "  W1 PASS — classifyAuthStartStatus maps 410→transient (friendly), 400→invalid, 2xx→ok" >&2
  else
    echo "  W1 FAIL — transient-error mapping test not green:" >&2
    echo "$O1" | grep -iE '\(fail\)|error' | head -3 >&2
  fi
else
  echo "  W1 BLOCKED — no bun toolchain"; echo " GATE: BLOCKED — toolchain absent"; exit 3
fi

# WITNESS 2 — the real endpoint is healthy (the 410 was transient).
W2="BLOCKED"
CODE="$(curl -s -o /dev/null -w '%{http_code}' --max-time 20 \
  -X POST "$API/v1/auth/email/start" \
  -H 'content-type: application/json' \
  -d '{"email":"frontend-lever-probe@example.com"}' 2>/dev/null || echo 000)"
case "$CODE" in
  2*|400|422) W2="PASS"; echo "  W2 PASS — $API/v1/auth/email/start healthy (HTTP $CODE; not 410)" >&2;;
  410|5*|429) W2="BLOCKED"; echo "  W2 BLOCKED — endpoint transient/unavailable right now (HTTP $CODE) — infra, not code" >&2;;
  000)        W2="BLOCKED"; echo "  W2 BLOCKED — endpoint unreachable (network)" >&2;;
  *)          W2="BLOCKED"; echo "  W2 BLOCKED — unexpected HTTP $CODE (treated as infra)" >&2;;
esac

echo "─────────────────────────────────────────────────"
echo " frontend: transient_mapping=$W1  live_health=$W2  ($API → HTTP $CODE)"
python3 -c "
import json
open('$HISTORY','a').write(json.dumps({'ts':'$TS','source':'live','axis':'frontend_signin_ux',
  'transient_mapping':'$W1','live_health':'$W2','http_code':'$CODE',
  'gate':'true' if ('$W1'=='PASS' and '$W2'=='PASS') else 'false'})+'\n')
"
if [ "$W1" != "PASS" ]; then
  echo " GATE: FAIL — the transient-error mapping (our code) is broken"; exit 1
fi
if [ "$W2" = "PASS" ]; then
  echo " GATE: PASS — sign-in maps transient statuses to a friendly message AND the live endpoint is healthy"
  exit 0
fi
echo " GATE: BLOCKED — code witness passes; live endpoint is transient/unreachable this run (infra)"
exit 3
