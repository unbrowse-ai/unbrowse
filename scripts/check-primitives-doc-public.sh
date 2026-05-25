#!/usr/bin/env bash
#
# scripts/check-primitives-doc-public.sh
#
# Honesty gate for docs/public/primitives/. Three checks:
#
# 1. No file under docs/public/primitives/ contains an internal substrate id.
#    Substrate ids are 8-character hex preceded by `contract`, `organ`, or
#    `contract:`. Reuses the patterns from check-contract-leak.sh.
#
# 2. Every primitive named in the README's "What lives here" inventory
#    has a corresponding file present in the same folder.
#
# 3. Every file under docs/public/primitives/ is named in the README inventory.
#    (Drift the other way: a new file added but README not updated.)
#
# Exit 0 = clean. Exit 1 = at least one check failed; specifics on stderr.

set -euo pipefail

cd "$(dirname "$0")/.."

FOLDER="docs/public/primitives"
README="$FOLDER/README.md"

if [ ! -d "$FOLDER" ]; then
  echo "[primitives-doc] $FOLDER missing — nothing to check" >&2
  exit 0
fi

if [ ! -f "$README" ]; then
  echo "[primitives-doc] $README missing — required" >&2
  exit 1
fi

FAILED=0

# Check 1: no internal substrate ids.
LEAKS=$(grep -REn 'contract [0-9a-f]{8}\b|organ [0-9a-f]{8}\b|contract:[0-9a-f]{8}\b|\bKEY [123]\b' "$FOLDER" --include='*.md' 2>/dev/null || true)
if [ -n "$LEAKS" ]; then
  echo "[primitives-doc] FAIL — substrate vocabulary leaked into public folder:" >&2
  echo "$LEAKS" >&2
  FAILED=1
fi

# Check 2: every README-listed file exists.
# Extract filenames the README's inventory references via [name](./filename.md).
MISSING_FILES=""
while IFS= read -r relpath; do
  [ -z "$relpath" ] && continue
  if [ ! -f "$FOLDER/$relpath" ]; then
    MISSING_FILES="$MISSING_FILES $relpath"
  fi
done < <(grep -oE '\]\(\./[a-z0-9-]+\.md\)' "$README" | sed 's|](\./||; s|)$||')

if [ -n "$MISSING_FILES" ]; then
  echo "[primitives-doc] FAIL — README references files that do not exist:" >&2
  for f in $MISSING_FILES; do echo "  $f" >&2; done
  FAILED=1
fi

# Check 3: every file is mentioned in the README.
UNLISTED=""
for f in "$FOLDER"/*.md; do
  name=$(basename "$f")
  [ "$name" = "README.md" ] && continue
  if ! grep -qF "($name)" "$README" && ! grep -qF "(./$name)" "$README"; then
    UNLISTED="$UNLISTED $name"
  fi
done

if [ -n "$UNLISTED" ]; then
  echo "[primitives-doc] FAIL — files in $FOLDER not referenced by README:" >&2
  for f in $UNLISTED; do echo "  $f" >&2; done
  FAILED=1
fi

if [ "$FAILED" -eq 0 ]; then
  echo "[primitives-doc] clean — README inventory matches folder; no substrate leaks"
  exit 0
fi
exit 1
