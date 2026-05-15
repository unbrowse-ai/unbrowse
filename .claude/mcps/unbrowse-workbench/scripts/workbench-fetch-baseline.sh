#!/usr/bin/env bash
# workbench-fetch-baseline.sh
# Fetch (build) the unbrowse binary for the previous release tag and cache it.
# Cache location: <repo>/.workbench-baseline/<tag>/unbrowse
# Prints the absolute path of the cached binary on stdout.
# Idempotent. Re-running with the same tag is a no-op.

set -euo pipefail

REPO_ROOT="/Users/lekt9/Projects/unbrowse-ecosystem/unbrowse"
CACHE_ROOT="$REPO_ROOT/.workbench-baseline"

log() { printf '[baseline-fetch] %s\n' "$*" >&2; }

# Step 1: select the previous tag (most recent v* tag before HEAD).
TAG="$(git -C "$REPO_ROOT" describe --tags --abbrev=0 --match='v*' HEAD~ 2>/dev/null || true)"
if [ -z "$TAG" ]; then
  log "no previous tag found; falling back to current tag"
  TAG="$(git -C "$REPO_ROOT" describe --tags --abbrev=0 --match='v*' HEAD 2>/dev/null || true)"
fi
if [ -z "$TAG" ]; then
  log "ERROR: no v* tag reachable from HEAD or HEAD~"
  exit 3
fi
log "selected baseline tag: $TAG"

CACHE_DIR="$CACHE_ROOT/$TAG"
CACHE_BIN="$CACHE_DIR/unbrowse"

# Step 2: if cached, short-circuit.
if [ -x "$CACHE_BIN" ]; then
  log "baseline already cached at $CACHE_BIN"
  printf '%s\n' "$CACHE_BIN"
  exit 0
fi

mkdir -p "$CACHE_DIR"

# Step 3: Strategy A: build via worktree of the tag.
WORKTREE_DIR="/tmp/unbrowse-baseline-$TAG-$$"
cleanup_worktree() {
  if [ -d "$WORKTREE_DIR" ]; then
    git -C "$REPO_ROOT" worktree remove --force "$WORKTREE_DIR" >/dev/null 2>&1 || rm -rf "$WORKTREE_DIR"
  fi
}
trap cleanup_worktree EXIT INT TERM

log "Strategy A: building from worktree of $TAG"
if ! git -C "$REPO_ROOT" worktree add "$WORKTREE_DIR" "$TAG" --detach >&2; then
  log "ERROR: failed to create worktree at $WORKTREE_DIR for tag $TAG"
  exit 5
fi

PLATFORM="$(uname -s | tr '[:upper:]' '[:lower:]')"
ARCH="$(uname -m)"
[ "$ARCH" = "aarch64" ] && ARCH="arm64"
[ "$ARCH" = "x86_64" ] && ARCH="x64"
TARGET="$PLATFORM-$ARCH"
DIST_BIN="$WORKTREE_DIR/dist/unbrowse-$TARGET"

STRATEGY_A_OK=0
if [ -x "$WORKTREE_DIR/scripts/build-binaries.sh" ]; then
  log "running scripts/build-binaries.sh inside worktree"
  if ( cd "$WORKTREE_DIR" && bash scripts/build-binaries.sh ) >&2; then
    if [ -f "$DIST_BIN" ]; then
      cp "$DIST_BIN" "$CACHE_BIN"
      chmod +x "$CACHE_BIN"
      STRATEGY_A_OK=1
    else
      log "Strategy A: build script ran but $DIST_BIN missing"
    fi
  else
    log "Strategy A: scripts/build-binaries.sh failed in worktree"
  fi
else
  log "Strategy A: scripts/build-binaries.sh not present on tag $TAG"
fi

if [ "$STRATEGY_A_OK" = "1" ]; then
  log "baseline cached at $CACHE_BIN"
  printf '%s\n' "$CACHE_BIN"
  exit 0
fi

# Step 4: Strategy B: npm pack the published version and extract the prebuilt binary.
# Not yet implemented; explicit failure so the human notices.
log "Strategy A failed; Strategy B (npm pack of $TAG) is not yet implemented."
log "Manual fallback: build $TAG yourself, then place the binary at $CACHE_BIN"
echo "[baseline-fetch] strategy B not yet implemented; ask Lewis to build manually" >&2
exit 4
