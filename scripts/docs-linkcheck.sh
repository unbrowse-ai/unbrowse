#!/usr/bin/env bash
# docs-linkcheck.sh — every relative markdown link in the authored/touched docs
# must resolve to a real file. Complements docs-anchor-check (which checks code
# paths) by checking doc→doc navigation. Scoped to the docs this work owns, so
# pre-existing breakage elsewhere in the tree is not this gate's burden.
#
# Usage: bash scripts/docs-linkcheck.sh
set -uo pipefail
ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

TARGET_DOCS=(
  docs/SUMMARY.md
  docs/CATALOGUE.md
  docs/architecture/README.md
  docs/architecture/OVERVIEW.md
  docs/architecture/SECURITY.md
  docs/architecture/PRIVACY.md
  docs/architecture/AUTH.md
  docs/architecture/PERFORMANCE.md
  docs/ows.md
  docs/ows-integration.md
)

MISS=0; CHECKED=0
for doc in "${TARGET_DOCS[@]}"; do
  [ -f "$doc" ] || { echo "  ✗ missing doc: $doc" >&2; MISS=$((MISS+1)); continue; }
  dir="$(dirname "$doc")"
  # Pull markdown link targets: the (...) in ](...). Keep only relative links to
  # .md files (skip http(s)://, mailto:, and bare #anchors). Strip any #fragment.
  while IFS= read -r target; do
    [ -z "$target" ] && continue
    case "$target" in
      http://*|https://*|mailto:*|\#*) continue ;;
    esac
    target="${target%% *}"          # drop any ](path "title") title suffix
    path="${target%%#*}"            # drop #fragment
    [ -z "$path" ] && continue       # was a pure #anchor
    case "$path" in
      *.md) : ;;
      *) continue ;;                 # only verify .md doc links here
    esac
    CHECKED=$((CHECKED+1))
    # Resolve relative to the doc's directory.
    if [ ! -f "$dir/$path" ]; then
      echo "  ✗ $doc → broken link: $target" >&2
      MISS=$((MISS+1))
    fi
  done < <(grep -oE '\]\([^)]+\)' "$doc" 2>/dev/null | sed -E 's/^\]\(//; s/\)$//')
done

echo "[docs-linkcheck] checked $CHECKED doc→doc links across ${#TARGET_DOCS[@]} docs"
if [ "$MISS" -eq 0 ]; then
  echo "[docs-linkcheck] ✓ every doc→doc link resolves"
  exit 0
else
  echo "[docs-linkcheck] ✗ FAIL: $MISS broken link(s)"
  exit 1
fi
