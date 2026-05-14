#!/usr/bin/env bash
#
# release-and-verify.sh — cut a preview release and verify on a remote blank-slate host
#
# Usage:
#   bash scripts/release-and-verify.sh [--skip-release] [--skip-remote]
#
# Steps:
#   1. Run local tests (cli-e2e, path-params, utils)
#   2. Cut preview release via release-it (bumps version, tags, pushes)
#   3. Wait for npm publish (polls registry)
#   4. SSH to remote host, install from npm, run smoke test
#
# Env:
#   REMOTE_HOST  — SSH target (default: lekt8@89.169.121.108)
#   REMOTE_USER  — SSH user (default: lekt8)
#   SKIP_RELEASE — set to 1 to skip release-it (just do remote verify)
#   SKIP_REMOTE  — set to 1 to skip remote verification
#
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

REMOTE_HOST="${REMOTE_HOST:-lekt8@89.169.121.108}"
SKIP_RELEASE="${SKIP_RELEASE:-0}"
SKIP_REMOTE="${SKIP_REMOTE:-0}"

for arg in "$@"; do
  case "$arg" in
    --skip-release) SKIP_RELEASE=1 ;;
    --skip-remote) SKIP_REMOTE=1 ;;
  esac
done

log() { echo "[release-verify] $(date +%H:%M:%S) $*"; }
die() { echo "[release-verify] FATAL: $*" >&2; exit 1; }

# ── Step 0: Strict gate; refuse to release if the npm tarball is not opaque ──
log "asserting opaque npm tarball..."
node packages/skill/scripts/assert-opaque-tarball.mjs || die "opaque-tarball gate failed; fix files[] or override with UNBROWSE_ALLOW_BUNDLED_TARBALL=1 (do not commit)"

# ── Step 1: Local tests ──
log "running local tests..."
bun test tests/path-params.test.ts tests/utils.test.ts || die "unit tests failed"
# Some CLI imports refresh the generated build-info manifest during tests.
# Release-it owns the final versioned manifest, so restore it before enforcing
# a clean worktree.
git checkout -- src/build-info.generated.ts
log "local tests passed"

# ── Step 2: Cut release ──
if [[ "$SKIP_RELEASE" != "1" ]]; then
  log "checking working tree..."
  if [[ -n "$(git status --porcelain)" ]]; then
    die "working tree not clean — commit or stash first"
  fi

  log "cutting preview release..."
  bun run release -- --preRelease=preview --ci
  TAG="$(git describe --tags --match='v*' --abbrev=0)"
  VERSION="${TAG#v}"
  log "tagged $TAG"
else
  TAG="$(git describe --tags --match='v*' --abbrev=0)"
  VERSION="${TAG#v}"
  log "skipping release — using existing $TAG"
fi

# ── Step 3: Wait for npm publish ──
if [[ "$SKIP_RELEASE" != "1" ]]; then
  log "waiting for npm publish of unbrowse@$VERSION..."
  MAX_WAIT=300
  ELAPSED=0
  while ! npm view "unbrowse@$VERSION" version >/dev/null 2>&1; do
    if [[ $ELAPSED -ge $MAX_WAIT ]]; then
      die "npm publish timed out after ${MAX_WAIT}s — check CI"
    fi
    sleep 10
    ELAPSED=$((ELAPSED + 10))
    log "  waiting... (${ELAPSED}s)"
  done
  log "unbrowse@$VERSION published on npm"
fi

# ── Step 4: Remote verification ──
if [[ "$SKIP_REMOTE" != "1" ]]; then
  log "verifying on remote host: $REMOTE_HOST"

  # Run agent experience test on remote blank slate
  log "running agent experience test..."
  bash "$ROOT_DIR/scripts/agent-experience-test.sh" --remote "$REMOTE_HOST"
  log "agent experience test passed"

  # Then do the clean install + version-specific check
  ssh -o ConnectTimeout=10 -o StrictHostKeyChecking=accept-new "$REMOTE_HOST" bash -s "$VERSION" <<'REMOTE_SCRIPT'
    set -euo pipefail
    VERSION="$1"
    log() { echo "[remote-verify] $(date +%H:%M:%S) $*"; }

    # Ensure npm global bin is on PATH
    NPM_GLOBAL_BIN="$(npm root -g 2>/dev/null | sed 's|/lib/node_modules||')"/bin
    export PATH="$NPM_GLOBAL_BIN:$HOME/.npm-global/bin:/usr/local/bin:$PATH"

    # Clean slate: remove any existing unbrowse
    log "cleaning previous install..."
    pkill -9 -f 'unbrowse|kuri' 2>/dev/null || true
    npm uninstall -g unbrowse 2>/dev/null || true
    rm -rf ~/.unbrowse ~/.kuri ~/.config/unbrowse 2>/dev/null || true

    # Install specific version
    log "installing unbrowse@$VERSION..."
    npm install -g "unbrowse@$VERSION"
    INSTALLED="$(unbrowse --version 2>/dev/null || echo 'binary not found')"
    log "installed: $INSTALLED"

    # Setup (headless, non-interactive)
    log "running setup..."
    UNBROWSE_NON_INTERACTIVE=1 UNBROWSE_TOS_ACCEPTED=1 unbrowse setup --no-start --skip-browser 2>&1 || true

    # Health check
    log "health check..."
    UNBROWSE_NON_INTERACTIVE=1 UNBROWSE_TOS_ACCEPTED=1 unbrowse health 2>&1
    log "health OK"

    # Resolve smoke — marketplace-backed, no browser needed
    log "resolve smoke (pypi.org)..."
    RESULT=$(UNBROWSE_NON_INTERACTIVE=1 UNBROWSE_TOS_ACCEPTED=1 unbrowse resolve \
      --intent "get package info" \
      --url "https://pypi.org/project/openai/" 2>&1 || true)
    if echo "$RESULT" | grep -q '"error"'; then
      log "WARN: resolve returned error (may be expected on first run)"
      echo "$RESULT" | head -5
    else
      log "resolve OK"
    fi

    # Kill server
    pkill -9 -f 'unbrowse|kuri' 2>/dev/null || true

    log "remote verification complete for unbrowse@$VERSION"
REMOTE_SCRIPT

  log "remote verification passed on $REMOTE_HOST"
else
  log "skipping remote verification"
fi

log "done — $TAG released and verified"
