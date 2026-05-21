#!/usr/bin/env bash
# verify-release-manifest.sh — live HMAC-SHA256 verifier for GET /v1/version
#
# Principle 20260521T194246Z-7ad798e3 (staging-then-prod with signed
# release manifest). Fetches the deployed artifact's /v1/version payload,
# recomputes the HMAC over `version|build_sha|deployed_at` using
# RELEASE_MANIFEST_SIGNING_SECRET, and asserts the server-emitted
# signed_manifest_hash matches.
#
# Exit codes:
#   0  — signed_manifest_hash matches the recomputed HMAC; all three
#         identity fields non-null; channel matches EXPECTED_CHANNEL when
#         set; build_sha matches EXPECTED_SHA when set
#   2  — endpoint returned non-2xx
#   3  — payload missing required field
#   4  — recomputed HMAC does not match server-emitted hash (tampered or
#         secret mismatch)
#   5  — EXPECTED_CHANNEL mismatch
#   6  — EXPECTED_SHA mismatch
#
# Required env: RELEASE_MANIFEST_SIGNING_SECRET
# Required arg: $1 = base URL (e.g. https://beta-api.unbrowse.ai)
# Optional env: EXPECTED_CHANNEL (production|staging), EXPECTED_SHA (40-hex git SHA)

set -euo pipefail

BASE="${1:-}"
if [ -z "$BASE" ]; then
  echo "usage: $0 <base-url>  (env: RELEASE_MANIFEST_SIGNING_SECRET; optional: EXPECTED_CHANNEL, EXPECTED_SHA)" >&2
  exit 64
fi
if [ -z "${RELEASE_MANIFEST_SIGNING_SECRET:-}" ]; then
  echo "RELEASE_MANIFEST_SIGNING_SECRET not set" >&2
  exit 64
fi

TMP=$(mktemp)
trap 'rm -f "$TMP"' EXIT

HTTP_CODE=$(curl -sS -o "$TMP" -w "%{http_code}" "${BASE%/}/v1/version" || true)
if [ "$HTTP_CODE" != "200" ]; then
  echo "non-2xx from ${BASE}/v1/version: http=$HTTP_CODE body=$(cat "$TMP")" >&2
  exit 2
fi

VERSION=$(python3 -c "import json,sys;print(json.load(open(sys.argv[1])).get('version') or '')" "$TMP")
BUILD_SHA=$(python3 -c "import json,sys;print(json.load(open(sys.argv[1])).get('build_sha') or '')" "$TMP")
DEPLOYED_AT=$(python3 -c "import json,sys;print(json.load(open(sys.argv[1])).get('deployed_at') or '')" "$TMP")
CHANNEL=$(python3 -c "import json,sys;print(json.load(open(sys.argv[1])).get('channel') or '')" "$TMP")
SIGNED_HASH=$(python3 -c "import json,sys;print(json.load(open(sys.argv[1])).get('signed_manifest_hash') or '')" "$TMP")

if [ -z "$VERSION" ] || [ -z "$BUILD_SHA" ] || [ -z "$DEPLOYED_AT" ]; then
  echo "manifest missing fields: version=$VERSION build_sha=$BUILD_SHA deployed_at=$DEPLOYED_AT" >&2
  echo "(CI vars UNBROWSE_VERSION/BUILD_SHA/DEPLOYED_AT not wired into deploy)" >&2
  exit 3
fi
if [ -z "$SIGNED_HASH" ]; then
  echo "manifest missing signed_manifest_hash (RELEASE_MANIFEST_SIGNING_SECRET not set on worker)" >&2
  exit 3
fi

PAYLOAD="${VERSION}|${BUILD_SHA}|${DEPLOYED_AT}"
COMPUTED=$(printf '%s' "$PAYLOAD" | openssl dgst -sha256 -hmac "$RELEASE_MANIFEST_SIGNING_SECRET" | awk '{print $NF}')

if [ "$COMPUTED" != "$SIGNED_HASH" ]; then
  echo "HMAC mismatch:" >&2
  echo "  payload : $PAYLOAD" >&2
  echo "  server  : $SIGNED_HASH" >&2
  echo "  recompute: $COMPUTED" >&2
  echo "  (either the secret on the worker differs from RELEASE_MANIFEST_SIGNING_SECRET, or the manifest was tampered post-build)" >&2
  exit 4
fi

if [ -n "${EXPECTED_CHANNEL:-}" ] && [ "$CHANNEL" != "$EXPECTED_CHANNEL" ]; then
  echo "channel mismatch: server=$CHANNEL expected=$EXPECTED_CHANNEL" >&2
  exit 5
fi

if [ -n "${EXPECTED_SHA:-}" ] && [ "$BUILD_SHA" != "$EXPECTED_SHA" ]; then
  echo "build_sha mismatch: server=$BUILD_SHA expected=$EXPECTED_SHA" >&2
  exit 6
fi

echo "OK: ${BASE}/v1/version"
echo "  version=$VERSION"
echo "  build_sha=$BUILD_SHA"
echo "  deployed_at=$DEPLOYED_AT"
echo "  channel=$CHANNEL"
echo "  signed_manifest_hash=$SIGNED_HASH  (verified, matches recomputed HMAC-SHA256)"
