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

# Step 1: select the previous STABLE tag (most recent v* tag before HEAD,
# excluding preview/rc/alpha/beta suffixes which may not have all the
# build scripts the workbench needs to compile a baseline binary).
TAG_MATCH_ARGS=(--match='v*' --exclude='*preview*' --exclude='*rc*' --exclude='*alpha*' --exclude='*beta*')
TAG="$(git -C "$REPO_ROOT" describe --tags --abbrev=0 "${TAG_MATCH_ARGS[@]}" HEAD~ 2>/dev/null || true)"
if [ -z "$TAG" ]; then
  log "no previous stable tag found; falling back to current tag"
  TAG="$(git -C "$REPO_ROOT" describe --tags --abbrev=0 "${TAG_MATCH_ARGS[@]}" HEAD 2>/dev/null || true)"
fi
if [ -z "$TAG" ]; then
  log "ERROR: no v* stable tag reachable from HEAD or HEAD~ (preview/rc/alpha/beta excluded)"
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

# Initialize submodules in the worktree. The build script depends on
# submodules/kuri being a populated checkout, but a fresh git worktree
# starts with empty submodule directories. Use the script's own
# ensure-submodules helper if present, else fall back to git submodule
# update --init.
if [ -x "$WORKTREE_DIR/scripts/ensure-submodules.sh" ]; then
  log "running ensure-submodules.sh in worktree"
  ( cd "$WORKTREE_DIR" && bash scripts/ensure-submodules.sh ) >&2 || log "WARN: ensure-submodules.sh failed; build may break"
else
  log "submodule init in worktree"
  ( cd "$WORKTREE_DIR" && git submodule update --init --recursive ) >&2 || log "WARN: git submodule update failed; build may break"
fi

# Install dependencies in the worktree. A fresh worktree has no
# node_modules; the build script imports dotenv + others. Use bun
# install (the project's package manager) without --save so package.json
# stays as the tag has it.
log "bun install in worktree"
( cd "$WORKTREE_DIR" && bun install --no-save --silent ) >&2 || log "WARN: bun install failed; build may break"

PLATFORM="$(uname -s | tr '[:upper:]' '[:lower:]')"
ARCH="$(uname -m)"
[ "$ARCH" = "aarch64" ] && ARCH="arm64"
[ "$ARCH" = "x86_64" ] && ARCH="x64"
TARGET="$PLATFORM-$ARCH"
DIST_BIN="$WORKTREE_DIR/dist/unbrowse-$TARGET"

STRATEGY_A_OK=0

# Strategy A2: if the build script is missing on this tag, copy build
# tooling from current HEAD into the worktree. The build script is
# tooling-only (not the binary's own source), so using HEAD's version
# against an older src/ is safe. Copies scripts/build-binaries.sh +
# scripts/build-release-manifest.ts + packages/skill/scripts/build-kuri-binaries.mjs
# (the three files build-binaries.sh references).
if [ ! -x "$WORKTREE_DIR/scripts/build-binaries.sh" ]; then
  log "Strategy A: scripts/build-binaries.sh not present on tag $TAG; copying build tooling from HEAD"
  mkdir -p "$WORKTREE_DIR/scripts" "$WORKTREE_DIR/packages/skill/scripts"
  for f in scripts/build-binaries.sh scripts/build-release-manifest.ts packages/skill/scripts/build-kuri-binaries.mjs; do
    if [ -f "$REPO_ROOT/$f" ]; then
      cp "$REPO_ROOT/$f" "$WORKTREE_DIR/$f"
      log "  copied $f"
    else
      log "  WARN $f missing in REPO_ROOT; build may fail"
    fi
  done
  chmod +x "$WORKTREE_DIR/scripts/build-binaries.sh"
fi

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
  log "Strategy A: scripts/build-binaries.sh still missing after copy attempt"
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
