#!/usr/bin/env bash
# Witness for the jesus-ralph north star:
#   `unbrowse fetch https://www.rootdata.com/Investors` returns REAL investor data,
#   not the Tencent WAF captcha challenge, with ZERO human interaction.
#
# Grades the skill's binary (UNBROWSE_BIN, default the PATH `unbrowse` the skill runs).
# Exit 0  == one-shot unsupervised pull succeeded (north star achieved).
# Exit 1  == captcha challenge, empty body, or no investor-data signal.
set -uo pipefail

BIN="${UNBROWSE_BIN:-unbrowse}"
URL="${ROOTDATA_WITNESS_URL:-https://www.rootdata.com/Investors}"
TIMEOUT="${ROOTDATA_WITNESS_TIMEOUT:-90}"

echo "[gate] bin=$BIN url=$URL timeout=${TIMEOUT}s"

# Unsupervised: plain non-interactive fetch. No auth, no visible browser, no human.
out="$(timeout "${TIMEOUT}" "$BIN" fetch --url "$URL" 2>/dev/null || true)"

# 1) Hard-fail on any captcha / WAF-challenge marker.
if printf '%s' "$out" | grep -qiE '__captcha|Captcha\.js|WafCaptcha|captcha\.qcloud|Refreshing too often|Verification Code'; then
  echo "[gate] FAIL: WAF captcha challenge returned (not one-shottable yet)"
  exit 1
fi

# 2) Body must be substantial (the captcha stub is < ~1.5KB).
len=$(printf '%s' "$out" | wc -c | tr -d ' ')
if [ "${len:-0}" -lt 1500 ]; then
  echo "[gate] FAIL: response too small (${len} bytes) — likely blocked/empty"
  exit 1
fi

# 3) Positive signal: the investors page / its API actually rendered.
if printf '%s' "$out" | grep -qiE 'investor|portfolio|venture|capital|\bfund\b'; then
  echo "[gate] PASS: real investor data (${len} bytes, no captcha)"
  exit 0
fi

echo "[gate] FAIL: no investor-data signal (${len} bytes)"
exit 1
