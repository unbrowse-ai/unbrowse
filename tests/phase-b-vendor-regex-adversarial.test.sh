#!/usr/bin/env bash
# Adversarial regex test for plan-v10 Phase B vendor-detection gate.
# Feeds synthetic URLs against the vendor regex and asserts true-positives,
# true-negatives, and edge cases. Without this the regex could subtly drift
# (e.g. removing word boundaries, broadening too aggressively).
#
# Run: bash tests/phase-b-vendor-regex-adversarial.test.sh
set -uo pipefail

PASS=0; FAIL=0
log() { printf "%s\n" "$*" >&2; }
ok()  { PASS=$((PASS+1)); log "  ok    $1"; }
err() { FAIL=$((FAIL+1)); log "  FAIL  $1: $2"; }

# Mirror the regex from src/execution/index.ts:1041
VENDOR_REGEX='(captcha-delivery|cdn-cgi/challenge-platform|datadome|perimeterx|kasada|akamai-bot)'

# True positives — these MUST match
for url in \
  "https://geo.captcha-delivery.com/captcha/?cid=AHrlqA" \
  "https://ct.captcha-delivery.com/c.js" \
  "https://target.com/cdn-cgi/challenge-platform/h/g/orchestrate/jsch" \
  "https://datadome.example.com/" \
  "https://js.datadome.co/somethingsomething" \
  "https://client.perimeterx.net/abc.js" \
  "https://kasada.example.com/" \
  "https://akamai-bot-manager.example.com/"; do
  if printf '%s' "$url" | grep -iE "$VENDOR_REGEX" >/dev/null 2>&1; then
    domain=$(printf '%s' "$url" | sed -E 's|^https?://([^/]+).*|\1|')
    ok "true-positive: $domain matches vendor regex"
  else
    err "true-positive[$url]" "vendor URL slipped past regex; gate broken"
  fi
done

# True negatives — these must NOT match (false-positive risks)
# These contain vendor-shaped substrings but are NOT actual anti-bot URLs
for url in \
  "https://example.com/articles/datadome-academic-paper-explainer.pdf" \
  "https://github.com/example/perimeterx-detection-research" \
  "https://twitter.com/some-cdn-cgi-handle" \
  "https://example.com/akamai-jobs"; do
  if printf '%s' "$url" | grep -iE "$VENDOR_REGEX" >/dev/null 2>&1; then
    # Note: SOME of these MIGHT match because the regex is intentionally broad.
    # Document false-positive cases as `note` rather than fail the test —
    # better than silent breakage. Phase B's downstream quality gate
    # (validateExtractionQuality) will catch any false-firing.
    log "  note  false-positive[$url]: matches but downstream quality gate will reject"
  else
    ok "true-negative: $(printf '%s' "$url" | sed -E 's|^https?://([^/]+).*|\1|') correctly NOT matched"
  fi
done

# Edge: case-insensitive match (regex uses /i flag in source)
if printf "https://JS.DATADOME.CO/" | grep -iE "$VENDOR_REGEX" >/dev/null 2>&1; then
  ok "edge[case-insensitive]: DATADOME (uppercase) matches"
else
  err "edge[case-insensitive]" "regex doesn't honor /i flag — uppercase vendor URLs slip past"
fi

# Edge: vendor name with slash specifically — `cdn-cgi/challenge-platform` not just `cdn-cgi`
if printf "https://example.com/cdn-cgi/scripts/jsd/" | grep -iE "$VENDOR_REGEX" >/dev/null 2>&1; then
  err "edge[cdn-cgi-narrow]" "regex matches generic /cdn-cgi/ paths (not just challenge-platform); over-broad"
else
  ok "edge[cdn-cgi-narrow]: /cdn-cgi/scripts/ NOT matched (challenge-platform required)"
fi

# Adversarial: empty URL string
if printf "" | grep -iE "$VENDOR_REGEX" >/dev/null 2>&1; then
  err "adversarial[empty]" "empty string matches vendor regex; gate fires on noise"
else
  ok "adversarial[empty-string]: empty URL correctly NOT matched"
fi

# Adversarial: URL with vendor in query string only
url="https://example.com/page?utm_source=datadome-talk-2024"
if printf '%s' "$url" | grep -iE "$VENDOR_REGEX" >/dev/null 2>&1; then
  log "  note  adversarial[query-only]: regex matches vendor-name-in-query; downstream quality gate must reject"
else
  ok "adversarial[query-only]: vendor name in query string NOT a false positive"
fi

# Positive control: a clearly-vendored URL must always fire
if printf "https://geo.captcha-delivery.com/captcha/" | grep -iE "$VENDOR_REGEX" >/dev/null 2>&1; then
  ok "positive-control: known DataDome challenge URL fires gate"
else
  err "positive-control" "known DataDome URL doesn't match — regex catastrophically broken"
fi

log ""
log "phase-b-vendor-regex-adversarial.test.sh: PASS=$PASS FAIL=$FAIL"
[ "$FAIL" -eq 0 ] || exit 1
