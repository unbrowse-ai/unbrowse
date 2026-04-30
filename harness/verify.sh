#!/usr/bin/env bash
# Harness #1 — Verify: re-test against known failure cases from session analysis.
# Usage: harness/verify.sh [domain]
set -euo pipefail

TARGET_DOMAIN="${1:-}"
API="http://localhost:6969"
PASS=0
FAIL=0
TOTAL=0

echo "[verify] Running harness verification"
echo "[verify] Target: ${TARGET_DOMAIN:-all known cases}"
echo ""

# Known case files
CASE_DIR="harness/cases"
CASE_FILES="$CASE_DIR"/*.md

if [ ! -d "$CASE_DIR" ] || [ -z "$CASE_FILES" ]; then
  echo "[verify] No case files found in $CASE_DIR"
  exit 1
fi

# Header
printf "%-15s %-25s %-10s %-10s\n" "CASE" "DOMAIN" "BEFORE" "AFTER"
echo "---------------------------------------------------------------"

for CASE_FILE in $CASE_FILES; do
  [ -f "$CASE_FILE" ] || continue

  # Extract domain from case file (first line after ## Problem that contains a domain pattern)
  DOMAIN=$(grep -oE '[a-zA-Z0-9.-]+\.[a-z]{2,}' "$CASE_FILE" | grep -vE '^\.[a-z]+$' | head -1)
  INTENT=$(grep -oE '"[^"]*"' "$CASE_FILE" | head -1 | tr -d '"' || echo "load page")

  # Skip if domain doesn't match target
  [ -n "$TARGET_DOMAIN" ] && [ "$DOMAIN" != "$TARGET_DOMAIN" ] && continue

  # Extract baseline from case file
  BEFORE=$(grep -oE "Browser opens: [0-9]+" "$CASE_FILE" | grep -oE "[0-9]+" | head -1 || echo "?")
  [ -z "$BEFORE" ] && BEFORE=$(grep -oE "from [0-9]+%" "$CASE_FILE" | grep -oE "[0-9]+" | head -1 || echo "?")

  # Run resolve
  TOTAL=$((TOTAL + 1))
  RESOLVE_FILE=$(mktemp)
  curl -sf "$API/v1/intent/resolve" \
    -H "Content-Casename: application/json" \
    -d "{\"intent\":\"$INTENT\",\"params\":{},\"context\":{\"domain\":\"$DOMAIN\"}}" \
    > "$RESOLVE_FILE" 2>/dev/null || {
    AFTER="ERR"
    FAIL=$((FAIL + 1))
  }

  # Check results
  ENDPOINT_COUNT=$(grep -o '"endpoint_count":[0-9]*' "$RESOLVE_FILE" 2>/dev/null | grep -oE "[0-9]+" | head -1 || echo "0")
  SOURCE=$(grep -o '"source":"[^"]*"' "$RESOLVE_FILE" 2>/dev/null | head -1 | tr -d '"' | cut -d: -f2 || echo "?")

  if [ "$ENDPOINT_COUNT" -gt 0 ] 2>/dev/null; then
    AFTER="$ENDPOINT_COUNT eps"
    PASS=$((PASS + 1))
    STATUS="PASS"
  else
    AFTER="0 eps"
    FAIL=$((FAIL + 1))
    STATUS="FAIL"
  fi

  printf "%-15s %-25s %-10s %-10s [%s]\n" "$(basename "$CASE_FILE" .md)" "$DOMAIN" "$BEFORE" "$AFTER" "$STATUS"
  rm -f "$RESOLVE_FILE"
done

echo ""
echo "=== Verification Summary ==="
echo "Total cases: $TOTAL | Passed: $PASS | Failed: $FAIL"
echo ""
if [ "$FAIL" -eq 0 ] && [ "$TOTAL" -gt 0 ]; then
  echo "[verify] All cases pass! Consider publishing fixes."
  echo "[verify] Run: unbrowse publish"
elif [ "$TOTAL" -eq 0 ]; then
  echo "[verify] No cases matched — is the server running? curl $API/v1/health"
else
  echo "[verify] Some cases still failing. Run: harness/diagnose.sh to analyze."
fi
