#!/usr/bin/env bash
set -euo pipefail

# --- prepare-release.sh ---
# Detects CLI-relevant changes since the last release tag, generates a
# changelog, suggests a semver bump, and optionally applies it.
#
# Usage:
#   ./scripts/prepare-release.sh              # dry run — show changelog + suggested bump
#   ./scripts/prepare-release.sh --apply      # bump versions, commit, tag, push
#   ./scripts/prepare-release.sh --bump minor # override bump type (patch|minor|major)

CLI_PATHS="src/ packages/skill/ bin/ scripts/build-binaries.sh scripts/smoke-packaged-cli.sh"
FRONTEND_ONLY_PATHS="frontend/"
BACKEND_ONLY_PATHS="backend/"

APPLY=0
FORCE_BUMP=""
PUSH=1

while [[ $# -gt 0 ]]; do
  case "$1" in
    --apply) APPLY=1; shift ;;
    --bump) FORCE_BUMP="$2"; shift 2 ;;
    --no-push) PUSH=0; shift ;;
    *) echo "Unknown flag: $1"; exit 1 ;;
  esac
done

cd "$(git rev-parse --show-toplevel)"

# Find the last release tag
LAST_TAG=$(git describe --tags --abbrev=0 --match 'v*' 2>/dev/null || echo "")
if [ -z "$LAST_TAG" ]; then
  echo "No previous v* tag found. Cannot diff."
  exit 1
fi

CURRENT_VERSION=$(node -p 'require("./packages/skill/package.json").version')
NPM_VERSION=$(npm view unbrowse version 2>/dev/null || echo "unknown")

echo "=== Release Prep ==="
echo "Last tag:        $LAST_TAG"
echo "Repo version:    $CURRENT_VERSION"
echo "npm version:     $NPM_VERSION"
echo ""

# Collect CLI-relevant commits since last tag
CLI_COMMITS=$(git log "$LAST_TAG"..HEAD --oneline -- $CLI_PATHS 2>/dev/null || true)
ALL_COMMITS=$(git log "$LAST_TAG"..HEAD --oneline 2>/dev/null || true)

if [ -z "$CLI_COMMITS" ]; then
  echo "No CLI-relevant changes since $LAST_TAG."
  echo ""
  echo "Changed paths since $LAST_TAG:"
  git diff --stat "$LAST_TAG"..HEAD -- $CLI_PATHS | head -20
  echo ""
  echo "Nothing to release for the CLI/npm package."
  if [ "$APPLY" -eq 0 ]; then exit 0; fi
  echo "Force applying anyway (--apply was set)..."
fi

echo "=== CLI Changes Since $LAST_TAG ==="
echo "$CLI_COMMITS"
echo ""

# Categorize by conventional commit prefix
BREAKING=$(echo "$CLI_COMMITS" | grep -iE '^\w+ (BREAKING|!:)' || true)
FEATURES=$(echo "$CLI_COMMITS" | grep -iE '^\w+ feat' || true)
FIXES=$(echo "$CLI_COMMITS" | grep -iE '^\w+ fix' || true)
REFACTORS=$(echo "$CLI_COMMITS" | grep -iE '^\w+ refactor' || true)
CHORES=$(echo "$CLI_COMMITS" | grep -iE '^\w+ chore' || true)
DOCS=$(echo "$CLI_COMMITS" | grep -iE '^\w+ docs' || true)
OTHER=$(echo "$CLI_COMMITS" | grep -viE '^\w+ (feat|fix|refactor|chore|docs|BREAKING)' || true)

# Determine bump type
if [ -n "$FORCE_BUMP" ]; then
  BUMP="$FORCE_BUMP"
elif [ -n "$BREAKING" ]; then
  BUMP="major"
elif [ -n "$FEATURES" ]; then
  BUMP="minor"
else
  BUMP="patch"
fi

# Calculate next version
IFS='.' read -r MAJOR MINOR PATCH <<< "$CURRENT_VERSION"
case "$BUMP" in
  major) NEXT_VERSION="$((MAJOR + 1)).0.0" ;;
  minor) NEXT_VERSION="${MAJOR}.$((MINOR + 1)).0" ;;
  patch) NEXT_VERSION="${MAJOR}.${MINOR}.$((PATCH + 1))" ;;
  *) echo "Invalid bump: $BUMP"; exit 1 ;;
esac

# Generate changelog
CHANGELOG=""
[ -n "$BREAKING" ] && CHANGELOG="${CHANGELOG}\n### Breaking Changes\n${BREAKING}\n"
[ -n "$FEATURES" ] && CHANGELOG="${CHANGELOG}\n### Features\n${FEATURES}\n"
[ -n "$FIXES" ] && CHANGELOG="${CHANGELOG}\n### Fixes\n${FIXES}\n"
[ -n "$REFACTORS" ] && CHANGELOG="${CHANGELOG}\n### Refactors\n${REFACTORS}\n"
[ -n "$CHORES" ] && CHANGELOG="${CHANGELOG}\n### Chores\n${CHORES}\n"
[ -n "$DOCS" ] && CHANGELOG="${CHANGELOG}\n### Docs\n${DOCS}\n"
[ -n "$OTHER" ] && CHANGELOG="${CHANGELOG}\n### Other\n${OTHER}\n"

echo "=== Changelog ==="
echo -e "$CHANGELOG"
echo ""
echo "=== Suggested Bump ==="
echo "  $CURRENT_VERSION -> $NEXT_VERSION ($BUMP)"
echo ""

if [ "$APPLY" -eq 0 ]; then
  echo "Dry run. Pass --apply to bump, commit, tag, and push."
  exit 0
fi

echo "=== Applying $BUMP bump: $CURRENT_VERSION -> $NEXT_VERSION ==="

# Bump version in all package.json files
for PKG in package.json packages/skill/package.json; do
  node -e "
    const fs = require('fs');
    const pkg = JSON.parse(fs.readFileSync('$PKG', 'utf8'));
    pkg.version = '$NEXT_VERSION';
    fs.writeFileSync('$PKG', JSON.stringify(pkg, null, 2) + '\n');
  "
  echo "  bumped $PKG -> $NEXT_VERSION"
done

# Write release notes for the GitHub release
echo -e "## v${NEXT_VERSION}\n${CHANGELOG}" > .release-notes.md
echo "  wrote .release-notes.md"

# Stage and commit
git add package.json packages/skill/package.json .release-notes.md
git commit -m "chore: release v${NEXT_VERSION}

$(echo -e "$CHANGELOG")
"

# Tag
git tag -a "v${NEXT_VERSION}" -m "Release v${NEXT_VERSION}"
echo "  tagged v${NEXT_VERSION}"

if [ "$PUSH" -eq 1 ]; then
  echo "  pushing main + tag..."
  git push origin main
  git push origin "v${NEXT_VERSION}"
  echo ""
  echo "=== Done ==="
  echo "Tag v${NEXT_VERSION} pushed. Release pipeline will:"
  echo "  1. Build CLI binaries"
  echo "  2. Upload to GitHub releases (unbrowse-ai/unbrowse)"
  echo "  3. Publish to npm"
  echo "  4. Deploy backend + frontend"
  echo "  5. Sync to public skill repo"
else
  echo ""
  echo "Tag created locally. Run: git push origin main && git push origin v${NEXT_VERSION}"
fi
