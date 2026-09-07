#!/usr/bin/env bash
# docs-site-adapters-gate.sh — the adapter docs live where docs.unbrowse.ai serves.
#
# docs.unbrowse.ai is the Next.js docs surface under frontend/src/app/docs/. This
# gate proves the adapter catalogue is published THERE (not only in the repo's
# docs/ markdown): a /docs/adapters page exists, covers every adapter family with
# representative package names + MCP, and is linked in the docs nav.
#
# Exits 0 iff the page exists, carries the families, and the nav links it.
set -uo pipefail
ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"
PAGE="frontend/src/app/docs/adapters/page.tsx"
NAV="frontend/src/app/docs/layout.tsx"
fail=0

echo "=== docs-site adapters page ==="
if [ ! -f "$PAGE" ]; then
  echo "  PAGE-FAIL: $PAGE missing"; fail=1
else
  # representative token from each family + MCP must appear on the page
  for tok in "drop-in" "axios" "playwright" "exa-js" "@unbrowse/ai-sdk" "unbrowse-requests" "crewai" "MCP" "npx unbrowse mcp"; do
    grep -qF -- "$tok" "$PAGE" || { echo "  PAGE-FAIL: page does not mention '$tok'"; fail=1; }
  done
  [ "$fail" -eq 0 ] && echo "  page: covers HTTP / browser / search / agent SDK / Python / MCP families"
fi

echo "=== docs nav links the page ==="
if [ -f "$NAV" ] && grep -qF "/docs/adapters" "$NAV"; then
  echo "  nav: $NAV links /docs/adapters"
else
  echo "  NAV-FAIL: $NAV does not link /docs/adapters"; fail=1
fi

echo
if [ "$fail" -ne 0 ]; then
  echo "DOCS-SITE-ADAPTERS-GATE FAIL — the adapter catalogue is not yet published on docs.unbrowse.ai."
  exit 1
fi
echo "DOCS-SITE-ADAPTERS-GATE PASS — the adapter catalogue is published on docs.unbrowse.ai and linked in the nav."
