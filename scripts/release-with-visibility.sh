#!/usr/bin/env bash
# release-with-visibility.sh — release-it wrapper with forced observability
#
# release-it sometimes dies silently with no stdout (especially in background
# shell invocations). This wrapper:
#   1. Captures all output to a log file
#   2. Prints state before and after each phase
#   3. Fails loudly with the last 50 lines of log if anything breaks
#   4. Tails the log in parallel so progress is visible
#
set -uo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

LOG=/tmp/release-it-$(date +%s).log
: > "$LOG"

log_state() {
  local phase="$1"
  echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━" | tee -a "$LOG"
  echo "[$phase] $(date '+%H:%M:%S')" | tee -a "$LOG"
  echo "  branch: $(git branch --show-current)" | tee -a "$LOG"
  echo "  head:   $(git log --oneline -1)" | tee -a "$LOG"
  echo "  version: $(grep '\"version\"' package.json | head -1 | tr -d ' ,')" | tee -a "$LOG"
  echo "  dirty:  $(git status --porcelain | wc -l | tr -d ' ') files" | tee -a "$LOG"
  echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━" | tee -a "$LOG"
}

die() {
  echo "[release] FAIL: $*" >&2
  echo "━━━ LAST 50 LINES OF LOG ━━━" >&2
  tail -50 "$LOG" >&2
  exit 1
}

log_state "BEFORE"

# Check working tree is clean
if [[ -n "$(git status --porcelain)" ]]; then
  die "working tree not clean — commit or stash first"
fi

# Fetch latest tags so release-it knows what's been published
git fetch --tags origin 2>&1 | tee -a "$LOG"

# Run release-it with full output capture
echo "[release] running release-it..." | tee -a "$LOG"
if ! GITHUB_TOKEN=$(gh auth token) bun run release -- --preRelease=preview --ci 2>&1 | tee -a "$LOG"; then
  die "release-it exited non-zero"
fi

log_state "AFTER"

# Verify tag was created
LATEST_TAG=$(git describe --tags --match='v*' --abbrev=0 2>/dev/null)
echo "[release] latest tag: $LATEST_TAG" | tee -a "$LOG"

# Verify tag was pushed
if git ls-remote --tags origin "refs/tags/$LATEST_TAG" 2>/dev/null | grep -q "$LATEST_TAG"; then
  echo "[release] ✓ tag $LATEST_TAG is on origin" | tee -a "$LOG"
else
  die "tag $LATEST_TAG NOT on origin — release-it may have silently skipped push"
fi

echo "[release] DONE — full log at $LOG"
