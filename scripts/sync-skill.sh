#!/usr/bin/env bash
# Sync only packages/skill/SKILL.md into the standalone skill repo
# AND install/update the Claude Code local skill.
#
# Usage: bash scripts/sync-skill.sh [commit message]

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
MONO_ROOT="$(dirname "$SCRIPT_DIR")"
SKILL_PKG="$MONO_ROOT/packages/skill"
SKILL_MD="$SKILL_PKG/SKILL.md"
DOCS_DIR="$MONO_ROOT/docs"
TARGET_REPO="${UNBROWSE_SKILL_REPO:-$HOME/Projects/unbrowse-skill}"

# --------------------------------------------------------------------------
# 1. Install / update Claude + Codex local skill links
# --------------------------------------------------------------------------

echo "=== Syncing Claude + Codex skill links ==="
bun "$SCRIPT_DIR/sync-skill-links.ts"
echo "Claude + Codex skill links ready."
echo ""

# --------------------------------------------------------------------------
# 1b. Sync CLI_REFERENCE into SKILL.md
# --------------------------------------------------------------------------

echo "=== Syncing CLI_REFERENCE into SKILL.md ==="
bun "$SCRIPT_DIR/sync-skill-md.ts"
echo ""

# --------------------------------------------------------------------------
# 2. Sync docs + SKILL.md to external skill repo (for publishing)
# --------------------------------------------------------------------------

if [ ! -d "$TARGET_REPO/.git" ]; then
  echo "Skipping repo sync: $TARGET_REPO is not a git repo"
  echo "(Set UNBROWSE_SKILL_REPO to override)"
  exit 0
fi

echo "=== Syncing $DOCS_DIR -> $TARGET_REPO/docs ==="
mkdir -p "$TARGET_REPO/docs"
rsync -a --delete "$DOCS_DIR/" "$TARGET_REPO/docs/"

echo "=== Syncing $SKILL_MD -> $TARGET_REPO/SKILL.md ==="
cp "$SKILL_MD" "$TARGET_REPO/SKILL.md"

if [ -f "$SKILL_PKG/README.md" ]; then
  echo "=== Syncing $SKILL_PKG/README.md -> $TARGET_REPO/README.md ==="
  cp "$SKILL_PKG/README.md" "$TARGET_REPO/README.md"
fi

# --------------------------------------------------------------------------
# 2b. Enforce binary-only: delete anything in target that isn't on the allowlist.
# The public mirror MUST NOT carry build inputs. Source ships via npm dist/*.js
# (registry tarball) and via platform binary tarballs attached to GitHub Releases.
# --------------------------------------------------------------------------

echo "=== Enforcing binary-only allowlist on $TARGET_REPO ==="
ALLOWED=(
  ".git" ".gitignore" ".env.example" ".zigrep_archive"
  "LICENSE" "README.md" "SKILL.md"
  "docs" "bin" "setup" "vendor" "package.json"
)
shopt -s nullglob dotglob
for entry in "$TARGET_REPO"/*; do
  name="$(basename "$entry")"
  [ "$name" = "." ] || [ "$name" = ".." ] && continue
  ok=0
  for allowed in "${ALLOWED[@]}"; do
    if [ "$name" = "$allowed" ]; then ok=1; break; fi
  done
  if [ "$ok" = "0" ]; then
    echo "  removing disallowed path: $name"
    rm -rf "$entry"
  fi
done
shopt -u dotglob

echo ""
echo "Sync complete. Files in $TARGET_REPO:"
ls -la "$TARGET_REPO/"

# Optionally commit, tag, and push
MSG="${1:-chore: sync from monorepo}"
cd "$TARGET_REPO"
TARGET_BRANCH="${UNBROWSE_SKILL_REPO_BRANCH:-$(git branch --show-current || true)}"
if [ -z "$TARGET_BRANCH" ]; then
  TARGET_BRANCH="$(git symbolic-ref --quiet --short refs/remotes/origin/HEAD 2>/dev/null | sed 's@^origin/@@')"
fi
if [ -z "$TARGET_BRANCH" ]; then
  TARGET_BRANCH="main"
fi
if git diff --quiet && git diff --staged --quiet; then
  echo ""
  echo "No changes to commit."
else
  git add -A
  echo ""
  echo "Changes to commit:"
  git diff --staged --stat
  echo ""
  if [ "${CI:-}" = "true" ]; then
    # Non-interactive mode for CI
    git commit -m "$MSG"
    git push origin "HEAD:$TARGET_BRANCH"
    echo "Pushed to $(git remote get-url origin)"
  else
    read -p "Commit and push with message '$MSG'? [y/N] " confirm
    if [[ "$confirm" =~ ^[Yy]$ ]]; then
      git commit -m "$MSG"
      git push origin "HEAD:$TARGET_BRANCH"
      echo "Pushed to $(git remote get-url origin)"
    else
      echo "Skipped commit. Changes are staged."
    fi
  fi
fi

# --------------------------------------------------------------------------
# 3. Tag skill repo if this is a release (message contains a version tag)
# --------------------------------------------------------------------------

# Extract version tag from commit message (e.g. "chore: release v1.2.0" → "v1.2.0")
VERSION_TAG=$(echo "$MSG" | grep -oE 'v[0-9]+\.[0-9]+\.[0-9]+' || true)
if [ -n "$VERSION_TAG" ]; then
  echo ""
  echo "=== Tagging skill repo with $VERSION_TAG ==="
  cd "$TARGET_REPO"
  git tag -fa "$VERSION_TAG" -m "Release $VERSION_TAG"
  git push origin "$VERSION_TAG" --force
  echo "Tagged and pushed $VERSION_TAG to $(git remote get-url origin)"

  # Create GitHub Release on skill repo using LLM-generated notes
  NOTES_FILE="$MONO_ROOT/.release-notes.md"
  if [ -f "$NOTES_FILE" ] && command -v gh &> /dev/null; then
    echo ""
    echo "=== Creating GitHub Release on skill repo ==="
    cd "$TARGET_REPO"
    gh release create "$VERSION_TAG" \
      --title "$VERSION_TAG" \
      --notes-file "$NOTES_FILE" \
      --repo unbrowse-ai/unbrowse
    echo "GitHub Release created for $VERSION_TAG"
  fi
fi
