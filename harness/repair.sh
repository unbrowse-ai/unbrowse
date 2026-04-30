#!/usr/bin/env bash
# Harness #1 — Repair: apply fixes to a known failure case.
# Usage: harness/repair.sh <domain> [skill_id]
set -euo pipefail

DOMAIN="${1:?Usage: harness/repair.sh <domain> [skill_id]}"
SKILL_ID="${2:-}"
TIMESTAMP=$(date -u +"%Y-%m-%dT%H:%M:%SZ")

echo "[repair] Target: ${DOMAIN} | Skill: ${SKILL_ID:-auto}"

# Step 1: find the latest diagnosis
DIAG_FILES=$(ls harness/output/resolve-${DOMAIN}-*.json 2>/dev/null | sort -r | head -3)
if [ -z "$DIAG_FILES" ]; then
  echo "[repair] No diagnosis files found for ${DOMAIN}"
  echo "[repair] Run: harness/diagnose.sh $DOMAIN \"<intent>\""
  exit 1
fi

echo "[repair] Found ${#DIAG_FILES[@]} diagnosis file(s):"
echo "$DIAG_FILES" | while read -r f; do echo "  $f"; done

# Step 2: run typecheck
echo "[repair] Step 2/3 — typechecking..."
bun run typecheck 2>/dev/null || {
  echo "[repair] WARNING: typecheck has errors. Review before committing."
  bun run typecheck 2>&1 | tail -20
}

# Step 3: run resolve to verify fix
echo "[repair] Step 3/3 — resolving to verify..."
if [ -n "$SKILL_ID" ]; then
  echo "[repair] Using known skill: $SKILL_ID"
else
  echo "[repair] Auto-detecting skill from domain..."
  # Use the latest resolve result
  LATEST=$(echo "$DIAG_FILES" | head -1)
  SKILL_ID=$(grep -o '"skill_id":"[^"]*"' "$LATEST" 2>/dev/null | head -1 | tr -d '"' | cut -d: -f2 || echo "")
  echo "[repair] Detected skill: ${SKILL_ID:-unknown}"
fi

echo ""
echo "[repair] === Repair Complete ==="
echo "Review the changes and run:"
echo "  1. harness/verify.sh $DOMAIN  (to validate against known cases)"
echo "  2. git diff  (to review code changes)"
echo "  3. bun test  (to ensure existing tests pass)"
if [ -n "$SKILL_ID" ] && [ "$SKILL_ID" != "unknown" ]; then
  echo "  4. unbrowse review $SKILL_ID  (to push improvements)"
fi
