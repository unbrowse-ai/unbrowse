#!/usr/bin/env bash
# Sync packages/skill/ into the unbrowse-skill repo (unbrowse-ai/unbrowse)
# AND install/update the Claude Code local skill.
#
# Usage: bash scripts/sync-skill.sh [commit message]

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
MONO_ROOT="$(dirname "$SCRIPT_DIR")"
SKILL_PKG="$MONO_ROOT/packages/skill"
TARGET_REPO="${UNBROWSE_SKILL_REPO:-$HOME/Projects/unbrowse-skill}"
KURI_SUBMODULE="$MONO_ROOT/submodules/kuri"

# --------------------------------------------------------------------------
# 1. Install / update Claude Code local skill
# --------------------------------------------------------------------------

CLAUDE_SKILLS_DIR="$HOME/.claude/skills"
AGENTS_SKILLS_DIR="$HOME/.agents/skills"

echo "=== Installing Claude Code skill ==="

# Ensure directories exist
mkdir -p "$CLAUDE_SKILLS_DIR" "$AGENTS_SKILLS_DIR"

# Create symlink in ~/.agents/skills/ → monorepo root (if not already pointing here)
if [ -L "$AGENTS_SKILLS_DIR/unbrowse" ]; then
  CURRENT_TARGET="$(readlink "$AGENTS_SKILLS_DIR/unbrowse")"
  if [ "$CURRENT_TARGET" != "$MONO_ROOT" ]; then
    echo "Updating ~/.agents/skills/unbrowse → $MONO_ROOT (was $CURRENT_TARGET)"
    rm "$AGENTS_SKILLS_DIR/unbrowse"
    ln -s "$MONO_ROOT" "$AGENTS_SKILLS_DIR/unbrowse"
  else
    echo "~/.agents/skills/unbrowse already points to $MONO_ROOT"
  fi
elif [ -e "$AGENTS_SKILLS_DIR/unbrowse" ]; then
  echo "Warning: ~/.agents/skills/unbrowse exists but is not a symlink. Skipping."
else
  echo "Creating ~/.agents/skills/unbrowse → $MONO_ROOT"
  ln -s "$MONO_ROOT" "$AGENTS_SKILLS_DIR/unbrowse"
fi

# Create symlink in ~/.claude/skills/ → ~/.agents/skills/unbrowse (Claude Code convention)
if [ -L "$CLAUDE_SKILLS_DIR/unbrowse" ]; then
  echo "~/.claude/skills/unbrowse already exists"
elif [ -e "$CLAUDE_SKILLS_DIR/unbrowse" ]; then
  echo "Warning: ~/.claude/skills/unbrowse exists but is not a symlink. Skipping."
else
  echo "Creating ~/.claude/skills/unbrowse → ../../.agents/skills/unbrowse"
  ln -s "../../.agents/skills/unbrowse" "$CLAUDE_SKILLS_DIR/unbrowse"
fi

echo "Claude Code skill installed."
echo ""

# --------------------------------------------------------------------------
# 1b. Sync CLI_REFERENCE into SKILL.md
# --------------------------------------------------------------------------

echo "=== Syncing CLI_REFERENCE into SKILL.md ==="
bun "$SCRIPT_DIR/sync-skill-md.ts"
echo ""

# --------------------------------------------------------------------------
# 2. Sync to external skill repo (for publishing)
# --------------------------------------------------------------------------

if [ ! -d "$TARGET_REPO/.git" ]; then
  echo "Skipping repo sync: $TARGET_REPO is not a git repo"
  echo "(Set UNBROWSE_SKILL_REPO to override)"
  exit 0
fi

echo "=== Syncing $SKILL_PKG -> $TARGET_REPO ==="

# Sync all files except .git, resolving symlinks (-L follows symlinks)
rsync -avL --delete \
  --exclude '.git' \
  --exclude 'node_modules' \
  --exclude '.env' \
  --exclude 'traces' \
  "$SKILL_PKG/" "$TARGET_REPO/"

if [ -d "$KURI_SUBMODULE" ]; then
  mkdir -p "$TARGET_REPO/vendor"
  rsync -av --delete \
    --exclude '.git' \
    --exclude '.zig-cache' \
    --exclude 'zig-out' \
    "$KURI_SUBMODULE/" "$TARGET_REPO/vendor/kuri-src/"
fi

# Also copy root-level .env.example if it exists
if [ -f "$MONO_ROOT/.env.example" ]; then
  cp "$MONO_ROOT/.env.example" "$TARGET_REPO/.env.example"
fi

echo ""
echo "Sync complete. Files in $TARGET_REPO:"
ls -la "$TARGET_REPO/"

# Optionally commit, tag, and push
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
  if [ "${CI:-}" = "true" ]; then
    # Non-interactive mode for CI
    git commit -m "$MSG"
    git push origin main
    echo "Pushed to $(git remote get-url origin)"
  else
    read -p "Commit and push with message '$MSG'? [y/N] " confirm
    if [[ "$confirm" =~ ^[Yy]$ ]]; then
      git commit -m "$MSG"
      git push origin main
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
  git tag -a "$VERSION_TAG" -m "Release $VERSION_TAG"
  git push origin "$VERSION_TAG"
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
