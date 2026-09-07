#!/usr/bin/env bash
# registry-gate — witness for the Smithery-structured restructure.
# Exit 0 iff the registry IA is real: registry home (search-over-grid), Aiko moved
# to /aiko, a skill detail page exists (the 404 gap filled), cards link to detail,
# and src typechecks. Visual fidelity is judged on the deployed preview.
set -uo pipefail
cd "$(dirname "$0")/.."   # frontend/
FAIL=0
need() { if [ ! -f "$1" ]; then echo "  ✗ missing $1 ($3)"; FAIL=1; return; fi
  grep -qiE -- "$2" "$1" || { echo "  ✗ $1: missing /$2/ ($3)"; FAIL=1; }; }

# 1. Home = registry (search over a real grid), NOT the chat
need src/app/page.tsx 'RegistrySearch' "home has the hero search"
need src/app/page.tsx 'RegistryCard|listPopularSkills' "home renders a real skills grid"
need src/app/page.tsx 'getStatsSummary|live calls|skills across' "home shows the registry stat hook"
need src/app/page.tsx '/aiko' "home links to the Aiko feature"
need src/app/page.tsx '/search' "home links into the full listing"
grep -q 'AikoHome' src/app/page.tsx && { echo "  ✗ home still mounts the chat (Aiko belongs at /aiko)"; FAIL=1; }

# 2. Aiko moved to its own route
need src/app/aiko/page.tsx 'AikoHome' "/aiko renders the chat"

# 3. Skill detail page exists (the 404 gap) + is real
need 'src/app/skill/[id]/page.tsx' 'getSkill' "/skill/[id] fetches the skill"
need 'src/app/skill/[id]/page.tsx' 'endpoints' "/skill/[id] lists routes"
need 'src/app/skill/[id]/page.tsx' 'Integrate|unbrowse resolve|unbrowse mcp' "/skill/[id] has an integrate panel"

# 4. Cards link to the detail page
need src/components/registry-card.tsx '/skill/' "cards link to the detail page"

# 5. real compile
echo "[registry-gate] typechecking src/ (stale .next stubs ignored)..."
SRC_ERRORS=$(timeout 180 bunx tsc --noEmit 2>&1 | grep -E '^src/' || true)
[ -z "$SRC_ERRORS" ] || { echo "  ✗ src type errors:"; printf '%s\n' "$SRC_ERRORS" | head -15 | sed 's/^/    /'; FAIL=1; }

[ "$FAIL" -ne 0 ] && { echo "[registry-gate] FAIL"; exit 1; }
echo "[registry-gate] PASS — registry home + /aiko + /skill detail wired; src typechecks"
