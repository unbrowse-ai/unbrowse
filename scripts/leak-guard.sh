#!/usr/bin/env bash
# leak-guard.sh — prevent harness/primitive techniques from leaking to public
#
# The Ralph loop primitives (coverage-harness, dogfood-loop,
# agent-experience-test, primitive-registry, etc.) are operational
# secret sauce. They must NOT appear in:
#   - npm tarball (packages/skill/ publish)
#   - GitHub release tarballs uploaded to unbrowse-ai/unbrowse
#   - any file committed to an explicitly public path
#
# This primitive checks every output path that can go public and
# flags if any sensitive name appears. Run before release and before
# push to main (as a pre-push hook).
#
# Usage:
#   bash scripts/leak-guard.sh              # check, exit non-zero on leak
#   bash scripts/leak-guard.sh --strict     # also fail on near-matches
#
set -uo pipefail

STRICT=false
for arg in "$@"; do
  case "$arg" in
    --strict) STRICT=true ;;
  esac
done

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

# Sensitive names that must never appear in public artifacts
SENSITIVE_NAMES=(
  "coverage-harness"
  "dogfood-loop"
  "agent-experience-test"
  "drop-in-onboarding-test"
  "primitive-registry"
  "release-with-visibility"
  "npm-dist-tag-sync"
  "npm-install-integrity"
  "leak-guard"
)

# Sensitive principle keywords from CLAUDE.md that shouldn't appear
# in public docs (strict mode only)
SENSITIVE_KEYWORDS=(
  "Harness Collects, Agent Judges"
  "Self-Prompting Harness"
  "No Specialized Testing"
  "Agent-as-Judge"
  "No Silent Failures"
)

# Public paths — any file under these is reachable by the outside world
PUBLIC_PATHS=(
  "packages/skill/SKILL.md"
  "packages/skill/README.md"
  "packages/skill/package.json"
  "README.md"
  "docs/"
)

LEAK_COUNT=0
LEAK_DETAILS=()

check_path() {
  local path="$1"
  if [ ! -e "$path" ]; then return; fi

  for name in "${SENSITIVE_NAMES[@]}"; do
    if grep -rIl "$name" "$path" 2>/dev/null | head -5 | while read -r f; do
      LEAK_COUNT=$((LEAK_COUNT + 1))
      LEAK_DETAILS+=("$name found in $f")
      echo "  ✗ LEAK: '$name' found in $f"
    done; then :; fi
    # grep -l doesn't export the loop vars due to subshell — use direct check
    local matches
    matches=$(grep -rIl "$name" "$path" 2>/dev/null | head -5 || true)
    if [ -n "$matches" ]; then
      while IFS= read -r f; do
        [ -z "$f" ] && continue
        echo "  ✗ LEAK in public path: '$name' in $f" >&2
        LEAK_COUNT=$((LEAK_COUNT + 1))
      done <<< "$matches"
    fi
  done
}

echo "[leak-guard] scanning public-reachable paths..."

# 1. Check each declared public path
for path in "${PUBLIC_PATHS[@]}"; do
  check_path "$path"
done

# 2. Check what would be in the npm tarball
echo ""
echo "[leak-guard] scanning simulated npm tarball..."
TAR_FILES=$(cd packages/skill && npm pack --dry-run 2>&1 | grep "npm notice" | awk '{print $NF}' | grep -v "notice")
for f in $TAR_FILES; do
  # Files relative to packages/skill — skip scripts/ which are allowlisted
  real_path="packages/skill/$f"
  if [ -f "$real_path" ]; then
    for name in "${SENSITIVE_NAMES[@]}"; do
      if grep -q "$name" "$real_path" 2>/dev/null; then
        echo "  ✗ LEAK in npm tarball: '$name' in $f" >&2
        LEAK_COUNT=$((LEAK_COUNT + 1))
      fi
    done
  fi
done

# 3. Strict mode: also check for principle keywords in public docs
if [ "$STRICT" = "true" ]; then
  echo ""
  echo "[leak-guard] strict mode — checking principle keywords..."
  for path in "${PUBLIC_PATHS[@]}"; do
    if [ -e "$path" ]; then
      for kw in "${SENSITIVE_KEYWORDS[@]}"; do
        matches=$(grep -rIl "$kw" "$path" 2>/dev/null | head -3 || true)
        if [ -n "$matches" ]; then
          while IFS= read -r f; do
            [ -z "$f" ] && continue
            echo "  ⚠ STRICT LEAK: '$kw' in $f" >&2
            LEAK_COUNT=$((LEAK_COUNT + 1))
          done <<< "$matches"
        fi
      done
    fi
  done
fi

# 4. Check the skill repo mirror if present
SKILL_REPO="${UNBROWSE_SKILL_REPO:-$HOME/Projects/unbrowse-skill}"
if [ -d "$SKILL_REPO/.git" ]; then
  echo ""
  echo "[leak-guard] scanning skill repo mirror: $SKILL_REPO"
  for name in "${SENSITIVE_NAMES[@]}"; do
    matches=$(grep -rIl "$name" "$SKILL_REPO" --exclude-dir=.git 2>/dev/null | head -3 || true)
    if [ -n "$matches" ]; then
      while IFS= read -r f; do
        [ -z "$f" ] && continue
        echo "  ✗ LEAK in skill repo: '$name' in $f" >&2
        LEAK_COUNT=$((LEAK_COUNT + 1))
      done <<< "$matches"
    fi
  done
fi

echo ""
if [ "$LEAK_COUNT" -eq 0 ]; then
  echo "[leak-guard] ✓ no sensitive names in public paths"
  exit 0
else
  echo "[leak-guard] ✗ FAIL: $LEAK_COUNT potential leak(s) found"
  echo "[leak-guard] sensitive primitives must NOT appear in:"
  echo "[leak-guard]   - packages/skill/SKILL.md, README.md, package.json"
  echo "[leak-guard]   - docs/"
  echo "[leak-guard]   - npm tarball"
  echo "[leak-guard]   - unbrowse-skill repo mirror"
  exit 1
fi
