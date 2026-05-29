#!/usr/bin/env bash
# R3: API direct via curl against beta-api.unbrowse.ai
#
# Honest-evidence-row contract:
#   - Hit the universally-mounted x402-gated route. Per
#     backend/src/index.ts:76 the prefix is `/v1/llm`, and the route inside
#     llm.ts:56 is `POST /:provider/messages` (NOT
#     `/v1/chat/completions` — that was an earlier-spec hypothesis). The
#     route gates on x402; absent a valid X-PAYMENT header it MUST return
#     402 with x402Version envelope, NOT 500 (CLAUDE.md no-stubs + sponsor
#     middleware contract). Model must exist in
#     https://ai.xgate.run/v1/models — `gpt-4o-mini` is not in the catalog
#     today, so we use `claude-sonnet-4-6` (confirmed live 2026-05-27).
#   - C1 (wallet): we'd ideally sign + retry, but the project lacks a
#     standalone x402-fetch CLI helper today. The harness HONESTLY records
#     this as `diagnostic=no_curl_x402_signer_available` for C1; the C1
#     evidence row is the bare 402 envelope, agent judges whether the
#     envelope shape is correct + would be signable.
#   - C2 (no wallet): bare curl. Expect 402 + envelope, NOT 500.
#
# Per CLAUDE.md: harness collects; agent judges. Never grep-derive verdict.

set -uo pipefail

CELL_ID="${MATRIX_CELL_ID:?MATRIX_CELL_ID required}"
ART_DIR="${MATRIX_ARTIFACT_DIR:?MATRIX_ARTIFACT_DIR required}"
API="${UNBROWSE_API_URL:-https://beta-api.unbrowse.ai}"

mkdir -p "$ART_DIR"
START_MS=$(python3 -c 'import time; print(int(time.time()*1000))')

# -----------------------------------------------------------------------------
# Probe 1: /v1/version — public unauth'd, proves backend reachable
# -----------------------------------------------------------------------------
curl -sS -o "$ART_DIR/version.body" -D "$ART_DIR/version.headers" \
  -w "version_http_code=%{http_code}\nversion_time=%{time_total}\n" \
  --max-time 15 \
  "$API/v1/version" > "$ART_DIR/version.curl-meta" 2>&1 || true

# -----------------------------------------------------------------------------
# Probe 2: /v1/llm/anthropic/messages — x402-gated paid surface (per
# backend/src/index.ts:76 mounting llmRoutes at /v1/llm, llm.ts:56 declaring
# POST /:provider/messages). Model `claude-sonnet-4-6` is in the xgate.run
# live catalog (verified 2026-05-27 via curl https://ai.xgate.run/v1/models).
# -----------------------------------------------------------------------------
LLM_PROVIDER="${MATRIX_LLM_PROVIDER:-anthropic}"
LLM_MODEL="${MATRIX_LLM_MODEL:-claude-sonnet-4-6}"
LLM_PAYLOAD="{\"model\":\"${LLM_MODEL}\",\"messages\":[{\"role\":\"user\",\"content\":\"reply with the single word ack\"}],\"max_tokens\":4}"

CURL_HEADERS=( -H "Content-Type: application/json" )

if [ "${MATRIX_COLUMN:-}" = "C1" ] && [ -n "${UNBROWSE_X_PAYMENT_HEADER:-}" ]; then
  # User-supplied pre-signed X-PAYMENT header (test environment); the harness
  # itself does not sign — that's the wrapper's job in src/payments/x402-fetch.ts.
  CURL_HEADERS+=( -H "X-PAYMENT: $UNBROWSE_X_PAYMENT_HEADER" )
  SIGNER_NOTE="x_payment_header_supplied"
else
  SIGNER_NOTE="no_x_payment_header"
fi

curl -sS -o "$ART_DIR/llm.body" -D "$ART_DIR/llm.headers" \
  -w "llm_http_code=%{http_code}\nllm_time=%{time_total}\n" \
  --max-time 30 \
  -X POST \
  "${CURL_HEADERS[@]}" \
  -d "$LLM_PAYLOAD" \
  "$API/v1/llm/${LLM_PROVIDER}/messages" > "$ART_DIR/llm.curl-meta" 2>&1 || true

# -----------------------------------------------------------------------------
# Decode sub_state from response shape
# -----------------------------------------------------------------------------
SUB_STATE=$(python3 - "$ART_DIR/llm.body" "$ART_DIR/llm.curl-meta" "$ART_DIR/llm.headers" "${SIGNER_NOTE}" <<'PY'
import json, sys, re
body_path, meta_path, headers_path, signer_note = sys.argv[1], sys.argv[2], sys.argv[3], sys.argv[4]
try:
    body = open(body_path).read()
except: body = ""
try:
    meta = open(meta_path).read()
except: meta = ""
try:
    headers = open(headers_path).read()
except: headers = ""

m = re.search(r'llm_http_code=(\d+)', meta)
code = int(m.group(1)) if m else 0

if code == 200:
    sub = "x402_signed" if signer_note == "x_payment_header_supplied" else "x402_unexpected_200_no_signer"
elif code == 402:
    # honest 402 — check envelope shape
    try:
        j = json.loads(body) if body else {}
        if "x402Version" in j or "accepts" in j:
            sub = "x402_no_wallet"  # envelope present, caller missing signer
        else:
            sub = "x402_envelope_missing"
    except Exception:
        sub = "x402_envelope_unparseable"
elif code in (500, 502, 503, 504):
    sub = "harness_red"  # this is what the rule forbids — agent must judge as RED
elif code == 0:
    sub = "harness_red"
else:
    sub = f"unexpected_http_{code}"
print(sub)
PY
)

END_MS=$(python3 -c 'import time; print(int(time.time()*1000))')

# Pull the http code into the summary
LLM_HTTP_CODE=$(grep -E '^llm_http_code=' "$ART_DIR/llm.curl-meta" 2>/dev/null | cut -d= -f2 || echo 0)
VERSION_HTTP_CODE=$(grep -E '^version_http_code=' "$ART_DIR/version.curl-meta" 2>/dev/null | cut -d= -f2 || echo 0)

{
  echo "cell_id=$CELL_ID"
  echo "api_base=$API"
  echo "version_http_code=$VERSION_HTTP_CODE"
  echo "llm_http_code=$LLM_HTTP_CODE"
  echo "llm_route=/v1/llm/${LLM_PROVIDER}/messages"
  echo "llm_model=${LLM_MODEL}"
  echo "signer_note=$SIGNER_NOTE"
  echo "exit_code=0"
  echo "duration_ms=$((END_MS-START_MS))"
  echo "sub_state=$SUB_STATE"
  echo "UNBROWSE_WALLET_ADAPTER_present=$([ -n "${UNBROWSE_WALLET_ADAPTER:-}" ] && echo true || echo false)"
  echo "UNBROWSE_WALLET_KEY_present=$([ -n "${UNBROWSE_WALLET_KEY:-}" ] && echo true || echo false)"
} > "$ART_DIR/summary.kv"

exit 0
