#!/usr/bin/env bash
# collect-roundtrip.sh — live IProyal 429 round-trip evidence collector.
#
# Plan: add-an-opt-in-paid-residential-proxy-fallback-fo / Wave 5.
#
# Substrate principle: COLLECTS evidence; DOES NOT judge. Emits one JSON
# object with the full {target, consent_set, decision_trace,
# pre_proxy_status, post_proxy_status, response_excerpt, surcharge_ledger}
# trace for an agent to judge in-thread. Never prints PASS/FAIL.
#
# Inputs:
#   IPROYAL_USER, IPROYAL_PASS  — IProyal creds (required for live run)
#   IPROYAL_HOST, IPROYAL_PORT   — optional overrides
#   TARGET_URL                   — defaults to httpbin.org/status/429
#   IP_URL                       — defaults to httpbin.org/ip
#
# Output: single JSON object on stdout.
set -uo pipefail

# Honest creds check — emits raw evidence row when missing.
CREDS_OK="true"
if [ -z "${IPROYAL_USER:-}" ] || [ -z "${IPROYAL_PASS:-}" ]; then
  CREDS_OK="false"
fi

TARGET_URL="${TARGET_URL:-https://httpbin.org/status/429}"
IP_URL="${IP_URL:-https://httpbin.org/ip}"

if [ "$CREDS_OK" = "false" ]; then
  python3 - <<PYJSON
import json, datetime
print(json.dumps({
  "ts": datetime.datetime.now(datetime.UTC).isoformat(),
  "target_url": "$TARGET_URL",
  "ip_url": "$IP_URL",
  "creds_present": False,
  "skipped_reason": "IPROYAL_USER or IPROYAL_PASS unset",
  "what_a_live_run_would_collect": {
    "step_1": "direct fetch of TARGET_URL — expected 429",
    "step_2": "proxied fetch via IProyal — observe post-proxy status and body",
    "step_3": "direct fetch of IP_URL — record baseline origin IP",
    "step_4": "proxied fetch of IP_URL — record proxied origin IP, compare",
    "step_5": "POST /v1/account/proxy-surcharge — record ledger_id and surcharge amount",
  },
  "next_step_for_agent": "set IPROYAL_USER+IPROYAL_PASS and re-run; agent then judges whether the proxied retry unblocked the target and the surcharge ledger row landed."
}, indent=2))
PYJSON
  exit 0
fi

# Live path.
IPROYAL_HOST="${IPROYAL_HOST:-geo.iproyal.com}"
IPROYAL_PORT="${IPROYAL_PORT:-12321}"
PROXY_URL="http://$(python3 -c "import urllib.parse,os;print(urllib.parse.quote(os.environ['IPROYAL_USER']))"):$(python3 -c "import urllib.parse,os;print(urllib.parse.quote(os.environ['IPROYAL_PASS']))")@${IPROYAL_HOST}:${IPROYAL_PORT}"

direct_target=$(curl -s -o /tmp/_rt_direct_target.body -w "%{http_code}" "$TARGET_URL" 2>/dev/null || echo "000")
proxied_target=$(curl -s -x "$PROXY_URL" -o /tmp/_rt_proxied_target.body -w "%{http_code}" "$TARGET_URL" 2>/dev/null || echo "000")
direct_ip_body=$(curl -s "$IP_URL" 2>/dev/null || echo '{"origin":"<unreachable>"}')
proxied_ip_body=$(curl -s -x "$PROXY_URL" "$IP_URL" 2>/dev/null || echo '{"origin":"<unreachable>"}')

python3 - <<PYJSON
import json, datetime, os
def _read(path, n=400):
    try:
        with open(path) as f: return f.read(n)
    except Exception: return ""
print(json.dumps({
  "ts": datetime.datetime.now(datetime.UTC).isoformat(),
  "target_url": "$TARGET_URL",
  "ip_url": "$IP_URL",
  "creds_present": True,
  "iproyal_host": "$IPROYAL_HOST",
  "direct_target_status": "$direct_target",
  "direct_target_body_excerpt": _read("/tmp/_rt_direct_target.body"),
  "proxied_target_status": "$proxied_target",
  "proxied_target_body_excerpt": _read("/tmp/_rt_proxied_target.body"),
  "direct_ip_body": $direct_ip_body if isinstance($direct_ip_body, dict) else "",
  "proxied_ip_body": $proxied_ip_body if isinstance($proxied_ip_body, dict) else "",
  "surcharge_call": "deferred — surcharge endpoint is backend-only; in-process executeEndpoint posts it during the real run (see decision_trace step 429_proxy_fallback_billed).",
  "for_agent_to_judge": [
    "Did the proxied egress IP differ from the direct egress IP?",
    "Did the proxied target return a different body or status than the direct target?",
    "Would the surcharge economy hold (real fetch went through paid proxy and target now responds)?"
  ]
}))
PYJSON
