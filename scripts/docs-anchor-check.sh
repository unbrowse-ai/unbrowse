#!/usr/bin/env bash
# docs-anchor-check.sh — every code path cited in the architecture deep-dives
# and the catalogue must resolve to a real file. A doc that cites a moved or
# renamed path fails the gate (the two-witness discipline for docs: the claim
# and the file must agree).
#
# Usage: bash scripts/docs-anchor-check.sh
# Exit 0 = every cited src/backend/frontend/scripts path exists.
set -uo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

# Docs whose code citations must all resolve. Overridable via
# DOCS_ANCHOR_TARGETS (space-separated paths) so a fails-closed self-test can
# point the check at a deliberately-broken probe doc without touching the live
# tree. Default behavior is identical when unset.
if [ -n "${DOCS_ANCHOR_TARGETS:-}" ]; then
  # shellcheck disable=SC2206
  TARGET_DOCS=( ${DOCS_ANCHOR_TARGETS} )
  [ "${#TARGET_DOCS[@]}" -gt 0 ] || { echo "[docs-anchor-check] ✗ DOCS_ANCHOR_TARGETS set but empty" >&2; exit 1; }
else
  TARGET_DOCS=(
    docs/CATALOGUE.md
    docs/architecture/SECURITY.md
    docs/architecture/PRIVACY.md
    docs/architecture/AUTH.md
    docs/architecture/PERFORMANCE.md
  )
fi

# Extract path-like tokens that carry a file extension we can verify. Bare
# directory/name references (e.g. "backend `auth.ts`") are intentionally not
# checked — only fully-qualified paths with a known extension.
EXT='ts|tsx|js|mjs|sh|py'
# The extension must be followed by a non-alphanumeric char or end-of-token, so
# a cited `x.json` is NOT silently satisfied by an existing `x.js` (the `js`
# prefix). The trailing delimiter is captured and stripped after extraction.
PATH_RE="(src|backend|frontend|packages|scripts)/[A-Za-z0-9_./-]+\.($EXT)([^A-Za-z0-9]|\$)"

MISS=0
CHECKED=0
for doc in "${TARGET_DOCS[@]}"; do
  [ -f "$doc" ] || { echo "  ✗ missing doc: $doc" >&2; MISS=$((MISS+1)); continue; }
  # Pull candidate paths out of inline-code spans and prose alike.
  while IFS= read -r p; do
    [ -z "$p" ] && continue
    CHECKED=$((CHECKED+1))
    if [ ! -e "$p" ]; then
      echo "  ✗ $doc cites missing path: $p" >&2
      MISS=$((MISS+1))
    fi
  done < <(grep -oE "$PATH_RE" "$doc" 2>/dev/null | sed -E 's/[^A-Za-z0-9]$//' | sort -u)
done

echo "[docs-anchor-check] checked $CHECKED unique cited paths across ${#TARGET_DOCS[@]} docs"
if [ "$MISS" -eq 0 ]; then
  echo "[docs-anchor-check] ✓ every cited code path resolves"
  exit 0
else
  echo "[docs-anchor-check] ✗ FAIL: $MISS unresolved path citation(s)"
  exit 1
fi
