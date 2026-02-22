#!/usr/bin/env bash
# Sync packages/skill/ into the unbrowse-skill repo (unbrowse-ai/unbrowse)
# Resolves the src/ symlink so the target repo gets real files.
#
# Usage: bash scripts/sync-skill.sh [commit message]

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
MONO_ROOT="$(dirname "$SCRIPT_DIR")"
SKILL_PKG="$MONO_ROOT/packages/skill"
TARGET_REPO="${UNBROWSE_SKILL_REPO:-$HOME/Projects/unbrowse-skill}"

if [ ! -d "$TARGET_REPO/.git" ]; then
  echo "Error: $TARGET_REPO is not a git repo"
  exit 1
fi

echo "Syncing $SKILL_PKG -> $TARGET_REPO"

# Sync all files except .git, resolving symlinks (-L follows symlinks)
rsync -avL --delete \
  --exclude '.git' \
  --exclude 'node_modules' \
  --exclude '.env' \
  "$SKILL_PKG/" "$TARGET_REPO/"

# Also copy root-level .env.example if it exists
if [ -f "$MONO_ROOT/.env.example" ]; then
  cp "$MONO_ROOT/.env.example" "$TARGET_REPO/.env.example"
fi

echo ""
echo "Sync complete. Files in $TARGET_REPO:"
ls -la "$TARGET_REPO/"

# Optionally commit and push
MSG="${1:-chore: sync from monorepo}"
cd "$TARGET_REPO"
if git diff --quiet && git diff --staged --quiet; then
  echo ""
  echo "No changes to commit."
else
  git add -A
  echo ""
  echo "Changes to commit:"
  git diff --staged --stat
  echo ""
  read -p "Commit and push with message '$MSG'? [y/N] " confirm
  if [[ "$confirm" =~ ^[Yy]$ ]]; then
    git commit -m "$MSG"
    git push origin main
    echo "Pushed to $(git remote get-url origin)"
  else
    echo "Skipped commit. Changes are staged."
  fi
fi
