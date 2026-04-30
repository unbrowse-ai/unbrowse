#!/usr/bin/env bash
# Harness #1 — Diagnose: analyze a known failure case with visual context.
# Usage: harness/diagnose.sh <domain> "<intent>" [output_dir]
set -euo pipefail

DOMAIN="${1:?Usage: harness/diagnose.sh <domain> \"<intent>\" [output_dir]}"
INTENT="${2:?Usage: harness/diagnose.sh <domain> \"<intent>\" [output_dir]}"
OUTDIR="${3:-harness/output}"
TIMESTAMP=$(date -u +"%Y-%m-%dT%H:%M:%SZ")
mkdir -p "$OUTDIR"

API="http://localhost:6969"
echo "[diagnose] Target: ${DOMAIN} — '${INTENT}'"
echo "[diagnose] Output dir: ${OUTDIR}"

# Step 1: resolve to find available endpoints
echo "[diagnose] Step 1/4 — resolving endpoints..."
RESOLVE_FILE="$OUTDIR/resolve-${DOMAIN}-${TIMESTAMP}.json"
curl -sf "$API/v1/intent/resolve" \
  -H "Content-Type: application/json" \
  -d "{\"intent\":\"$INTENT\",\"params\":{},\"context\":{\"domain\":\"$DOMAIN\"}}" \
  > "$RESOLVE_FILE" 2>/dev/null || {
  echo "[diagnose] resolve failed — server may not be running at $API"
  echo "[diagnose] Start with: bun run src/server.ts"
  exit 1
}

# Step 2: extract results
RESULT=$(cat "$RESOLVE_FILE")
SOURCE=$(echo "$RESULT" | grep -o '"source":"[^"]*"' | head -1 || echo "unknown")
SKILL_ID=$(echo "$RESULT" | grep -o '"skill_id":"[^"]*"' | head -1 | tr -d '"' | cut -d: -f2 || echo "")
STATUS=$(echo "$RESULT" | grep -o '"status":"[^"]*"' | head -1 || echo "unknown")
ENDPOINT_COUNT=$(echo "$RESULT" | grep -o '"endpoint_count":[0-9]*' | head -1 | cut -d: -f2 || echo "0")

echo "[diagnose]  Source: $SOURCE | Skill: $SKILL_ID | Endpoints: $ENDPOINT_COUNT | Status: $STATUS"

# Step 3: load the case file if it exists
CASE_FILE="harness/cases/$(echo "$DOMAIN" | tr -s '.' '_').md"
[ -f "$CASE_FILE" ] || CASE_FILE=""
if [ -n "$CASE_FILE" ]; then
  echo "[diagnose] Found case file: $CASE_FILE"
  echo "[diagnose] Known issues from case:"
  grep "^- " "$CASE_FILE" | head -5 | while read -r line; do echo "  $line"; done
else
  echo "[diagnose] No case file found for ${DOMAIN}"
fi

# Step 4: capture visual context via go (if browser is available)
echo "[diagnose] Step 4/4 — attempting visual context capture..."
BASE_URL="https://${DOMAIN}"
if [ -n "$SKILL_ID" ] && [ "$SKILL_ID" != "null" ] && [ "$SKILL_ID" != "" ]; then
  # If we found a skill, check if validate endpoint has more context
  VALIDATE_FILE="$OUTDIR/validate-${DOMAIN}-${TIMESTAMP}.json"
  curl -sf "$API/v1/skills/${SKILL_ID}/validate?url=${BASE_URL}" \
    > "$VALIDATE_FILE" 2>/dev/null || echo "[diagnose] validate endpoint returned empty"
  echo "[diagnose] Validation data saved to: $VALIDATE_FILE"
fi

# Summary
echo ""
echo "=== Diagnosis Summary ==="
echo "Domain:      $DOMAIN"
echo "Intent:      $INTENT"
echo "Resolve:     $SOURCE | $ENDPOINT_COUNT endpoints"
echo "Skill ID:    ${SKILL_ID:-none}"
echo "Resolve JSON: $RESOLVE_FILE"
[ -n "$CASE_FILE" ] && echo "Case file:   $CASE_FILE"
echo ""
echo "Next steps:"
echo "  1. Review $RESOLVE_FILE for endpoint quality"
echo "  2. Run: unbrowse go $BASE_URL  (to see the page)"
echo "  3. Run: unbrowse snap --filter interactive (to find API triggers)"
echo "  4. If the fix is clear, run: harness/repair.sh $DOMAIN"
echo "  5. If not, create a new case file at: harness/cases/$(echo "$DOMAIN" | tr -s '.' '_').md"
