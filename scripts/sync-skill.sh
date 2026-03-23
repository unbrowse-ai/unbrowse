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
WHITEPAPER_DOCS_DIR="$MONO_ROOT/docs/whitepaper"
TARGET_BRANCH="${UNBROWSE_SKILL_BRANCH:-$(git -C "$TARGET_REPO" rev-parse --abbrev-ref HEAD 2>/dev/null || echo main)}"

PACKAGE_SYNC_PATHS=()
while IFS= read -r path; do
  PACKAGE_SYNC_PATHS+=("$path")
done < <(cd "$SKILL_PKG" && find . -mindepth 1 -maxdepth 1 | sed 's#^\./##' | sort)
FILTERED_PACKAGE_SYNC_PATHS=()
for path in "${PACKAGE_SYNC_PATHS[@]}"; do
  case "$path" in
    *.tgz) ;;
    *) FILTERED_PACKAGE_SYNC_PATHS+=("$path") ;;
  esac
done
PACKAGE_SYNC_PATHS=("${FILTERED_PACKAGE_SYNC_PATHS[@]}")
STAGE_PATHS=("${PACKAGE_SYNC_PATHS[@]}")
STAGE_PATHS+=("*.tgz")

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

# Replace any top-level symlinks in the target with real files/directories from the package.
for path in "${PACKAGE_SYNC_PATHS[@]}"; do
  if [ -L "$TARGET_REPO/$path" ]; then
    echo "Removing target symlink before sync: $path"
    rm "$TARGET_REPO/$path"
  fi
done

# Remove stale packaged tarballs from the publish repo root. These are local build artifacts,
# not source, and `rsync --delete` will not remove excluded files for us.
while IFS= read -r tgz; do
  [ -n "$tgz" ] || continue
  echo "Removing stale package artifact from target: $(basename "$tgz")"
  rm -f "$tgz"
done < <(find "$TARGET_REPO" -maxdepth 1 -type f -name '*.tgz' | sort)

# Sync all files except .git, resolving symlinks (-L follows symlinks)
rsync -avL --delete \
  --exclude '.git' \
  --exclude 'node_modules' \
  --exclude '.env' \
  --exclude '*.tgz' \
  --exclude 'traces' \
  "$SKILL_PKG/" "$TARGET_REPO/"

if [ -d "$KURI_SUBMODULE" ]; then
  mkdir -p "$TARGET_REPO/vendor"
  rsync -av --delete \
    --exclude '.git' \
    --exclude '.zig-cache' \
    --exclude 'zig-out' \
    "$KURI_SUBMODULE/" "$TARGET_REPO/vendor/kuri-src/"
  STAGE_PATHS+=("vendor/kuri-src")
fi

# Also copy root-level .env.example if it exists
if [ -f "$MONO_ROOT/.env.example" ]; then
  cp "$MONO_ROOT/.env.example" "$TARGET_REPO/.env.example"
  STAGE_PATHS+=(".env.example")
fi

if [ -d "$WHITEPAPER_DOCS_DIR" ]; then
  mkdir -p "$TARGET_REPO/docs"
  rsync -av --delete \
    --exclude '.git' \
    "$WHITEPAPER_DOCS_DIR/" "$TARGET_REPO/docs/whitepaper/"
  STAGE_PATHS+=("docs/whitepaper")
fi

echo ""
echo "Sync complete. Files in $TARGET_REPO:"
ls -la "$TARGET_REPO/"

# Optionally commit, tag, and push
MSG="${1:-chore: sync from monorepo}"
cd "$TARGET_REPO"
FILTERED_STAGE_PATHS=()
for path in "${STAGE_PATHS[@]}"; do
  if git check-ignore -q -- "$path" && ! git ls-files --error-unmatch -- "$path" >/dev/null 2>&1; then
    continue
  fi
  if [ -e "$TARGET_REPO/$path" ] || [ -L "$TARGET_REPO/$path" ] || git ls-files --error-unmatch -- "$path" >/dev/null 2>&1; then
    FILTERED_STAGE_PATHS+=("$path")
  fi
done

git add -A -- "${FILTERED_STAGE_PATHS[@]}"
if git diff --cached --quiet -- "${FILTERED_STAGE_PATHS[@]}"; then
  echo ""
  echo "No changes to commit."
else
  echo ""
  echo "Changes to commit:"
  git diff --staged --stat
  echo ""
  if [ "${CI:-}" = "true" ]; then
    # Non-interactive mode for CI
    git commit -m "$MSG"
    git push origin "$TARGET_BRANCH"
    echo "Pushed to $(git remote get-url origin)"
  else
    read -p "Commit and push with message '$MSG'? [y/N] " confirm
    if [[ "$confirm" =~ ^[Yy]$ ]]; then
      git commit -m "$MSG"
      git push origin "$TARGET_BRANCH"
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
