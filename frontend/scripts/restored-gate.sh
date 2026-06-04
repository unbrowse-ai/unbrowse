#!/usr/bin/env bash
# restored-gate.sh — binding witness for the "restore the cool stuff" loop.
#
# Exits 0 ONLY when every targeted cool component/feature from ~a month ago is
# back AND reused (wired into a live page), not orphaned. Run from frontend/.
#
#   bash scripts/restored-gate.sh
#
# A COMPONENT counts as "reused" when it is imported somewhere under src/app
# (a page renders it) OR by a component that is itself imported under src/app
# (one hop — enough to catch section-in-section composition).
# A deleted PAGE counts as "restored" when its src/app/<route>/page.tsx exists.
set -uo pipefail
cd "$(dirname "$0")/.." || exit 2

# Cool components to wire back into live pages (orphaned after the registry redesign).
COMPONENTS=(
  speed-comparison
  works-with
  use-cases-band
  internet-evolution
  universal-proof-band
  trust-strip
  adopters-rail
  constellation
  cursor-particles
)

# Deleted pages to restore at their routes.
PAGES=(
  mine-the-internet
  miners
  leaderboard
  proof-of-indexing
  proof-of-indexing-vs-proof-of-work
  top-domains-to-mine
  agent-fleet-economics
  openclaw-earn
)

fail=0

# Set of components directly imported under src/app (page-level wiring).
app_imports="$(git grep -hoE "components/[a-z0-9-]+" -- src/app 2>/dev/null | sed 's#components/##' | sort -u)"

is_wired() {
  local name="$1"
  # direct: imported under src/app
  if printf '%s\n' "$app_imports" | grep -qx "$name"; then return 0; fi
  # one hop: imported by a component that is itself imported under src/app
  local importers
  importers="$(git grep -lE "components/$name([\"'/]|$)" -- src/components 2>/dev/null)"
  local f base
  for f in $importers; do
    base="$(basename "$f" .tsx)"
    if printf '%s\n' "$app_imports" | grep -qx "$base"; then return 0; fi
  done
  return 1
}

echo "== components (must be reused on a live page) =="
for c in "${COMPONENTS[@]}"; do
  if [ ! -f "src/components/$c.tsx" ]; then echo "  MISSING  $c (file gone)"; fail=1; continue; fi
  if is_wired "$c"; then echo "  WIRED    $c"; else echo "  ORPHAN   $c"; fail=1; fi
done

echo "== pages (must be restored at their route) =="
for p in "${PAGES[@]}"; do
  if [ -f "src/app/$p/page.tsx" ]; then echo "  RESTORED $p"; else echo "  MISSING  $p"; fail=1; fi
done

if [ "$fail" -eq 0 ]; then
  echo "RESTORED: all targeted cool stuff is back and reused."
  exit 0
fi
echo "NOT SETTLED: items above marked ORPHAN/MISSING still need restoring."
exit 1
