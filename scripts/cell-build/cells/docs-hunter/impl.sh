#!/usr/bin/env bash
# docs-hunter/impl.sh <domain>
# Probe every known documentation location on <domain>, emit a DocsBlob
# JSON artifact listing what was found. PII-redacts known patterns before
# writing.
#
# v0: uses curl directly. v1 will route through `unbrowse resolve` so the
# docs fetch itself becomes an unbrowse cell call.
set -uo pipefail

DOMAIN="${1:-}"
if [ -z "$DOMAIN" ]; then
  echo "usage: impl.sh <domain>" >&2
  exit 2
fi

# Strip protocol/path if the user passed a full URL by accident.
DOMAIN="${DOMAIN#https://}"
DOMAIN="${DOMAIN#http://}"
DOMAIN="${DOMAIN%%/*}"

OUT_DIR=".bench-local/docs-hunter"
mkdir -p "$OUT_DIR"
OUT="$OUT_DIR/${DOMAIN}.json"
RAW_DIR="$OUT_DIR/${DOMAIN}.raw"
mkdir -p "$RAW_DIR"

SOURCES=(
  "/.well-known/llms.txt"
  "/llms.txt"
  "/openapi.json"
  "/swagger.json"
  "/api/v1/openapi.json"
  "/api/openapi.json"
  "/.well-known/ai-plugin.json"
  "/.well-known/openid-configuration"
  "/robots.txt"
  "/sitemap.xml"
  "/docs/api"
  "/api-docs"
)

UA="Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Safari/605.1.15"

probe() {
  local url="$1"
  local fname="$2"
  local file="$RAW_DIR/$fname"
  # -s silent, -L follow redirects, -I first to get status cheaply, -o to save body
  # Single call: save headers + body, capture status.
  curl -sL -o "$file" -w '%{http_code}|%{content_type}|%{size_download}|%{time_total}' \
    -H "User-Agent: $UA" \
    -H "Accept: application/json, text/plain, */*" \
    --max-time 15 \
    "https://${DOMAIN}${url}" 2>/dev/null || echo "000||0|0"
}

# PII / secret redaction for the body preview. Simple patterns; good enough
# for a preview slug. Full-body storage stays out of the JSON record — only
# a short truncated slug is embedded.
redact_preview() {
  python3 - <<'PY'
import sys, re
body = sys.stdin.read()[:400]
# Strip obvious secrets and PII
body = re.sub(r'sk_(live|test)_[A-Za-z0-9]+', '[STRIPE_KEY]', body)
body = re.sub(r'AIza[0-9A-Za-z_-]{35}', '[GOOGLE_KEY]', body)
body = re.sub(r'[\w.+-]+@[\w-]+\.[\w.-]+', '[EMAIL]', body)
body = re.sub(r'Bearer [A-Za-z0-9._~+/-]+', 'Bearer [REDACTED]', body)
body = re.sub(r'eyJ[A-Za-z0-9_-]{20,}', '[JWT]', body)
body = body.replace('\n', ' ').replace('\r', '')
print(body[:200])
PY
}

# Build the JSON record
TMP="$(mktemp)"
{
  printf '{\n'
  printf '  "domain": "%s",\n' "$DOMAIN"
  printf '  "fetched_at": "%s",\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)"
  printf '  "fetcher": "curl",\n'
  printf '  "sources": [\n'

  FIRST=1
  HITS=0
  for src in "${SOURCES[@]}"; do
    # sanitize filename
    fname="$(printf '%s' "$src" | tr '/?=&' '____' | sed 's/^_*//')"
    [ -z "$fname" ] && fname="_root"

    metrics="$(probe "$src" "$fname")"
    status="$(printf '%s' "$metrics" | cut -d'|' -f1)"
    ctype="$(printf '%s' "$metrics" | cut -d'|' -f2)"
    size="$(printf '%s' "$metrics" | cut -d'|' -f3)"
    elapsed="$(printf '%s' "$metrics" | cut -d'|' -f4)"

    preview=""
    if [ -s "$RAW_DIR/$fname" ] && [ "$status" = "200" ]; then
      preview="$(head -c 400 "$RAW_DIR/$fname" | redact_preview)"
      HITS=$((HITS+1))
    fi

    [ $FIRST -eq 0 ] && printf ',\n'
    FIRST=0
    # jq-safe string encoding via python
    python3 - "$src" "$status" "$ctype" "$size" "$elapsed" "$preview" <<'PY'
import json, sys
src, status, ctype, size, elapsed, preview = sys.argv[1:7]
print(json.dumps({
    "path": src,
    "status": int(status) if status.isdigit() else 0,
    "content_type": ctype,
    "size_bytes": int(size) if size.isdigit() else 0,
    "time_sec": float(elapsed) if elapsed else 0.0,
    "preview": preview,
}, indent=2))
PY
  done

  printf '\n  ],\n'
  printf '  "hit_count": %d\n' "$HITS"
  printf '}\n'
} > "$TMP"

mv "$TMP" "$OUT"
echo "[docs-hunter] $DOMAIN → $OUT (hits=$HITS)"
[ "$HITS" -gt 0 ] || { echo "[docs-hunter] zero authoritative sources found for $DOMAIN" >&2; exit 2; }
exit 0
