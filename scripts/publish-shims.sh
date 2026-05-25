#!/usr/bin/env bash
# scripts/publish-shims.sh — publish the three shim packages to npm.
#
# Why this isn't in release.yml yet: creating a brand-new package name
# under the `@unbrowse/*` org scope requires npm CLI logged in as a
# maintainer of the org (with 2FA OTP at publish time, since the
# `getfoundry` account has 2FA-and-writes enabled). The granular
# `NPM_TOKEN` and `NPM_TOKEN_SDK` automation tokens only have access
# to packages that ALREADY exist — they 404 on PUT for new names.
#
# Run this once from your authenticated local machine. After the first
# publish, subsequent versions can be cut from CI via the existing
# automation token (since the package now exists in the @unbrowse scope).
#
# Usage:
#   npm login                              # if not already logged in as getfoundry
#   bash scripts/publish-shims.sh          # publishes all three at their current package.json versions
#   bash scripts/publish-shims.sh dry-run  # npm pack --dry-run for inspection only

set -euo pipefail

ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
DRY_RUN="${1:-}"

publish_one() {
  local pkg_dir="$1"
  echo
  echo "=== $(basename "$pkg_dir") ==="
  cd "$ROOT_DIR/$pkg_dir"

  # Build if dist/ is missing or stale
  if [ ! -d dist ] || [ src/index.ts -nt dist/index.js ]; then
    echo "[build] regenerating dist/"
    bun build src/index.ts $([ -f src/chromium.ts ] && echo src/chromium.ts) \
      --outdir dist --target node --format esm
  fi

  if [ "$DRY_RUN" = "dry-run" ]; then
    npm publish --dry-run --access public
  else
    npm publish --access public
  fi
}

publish_one packages/playwright-shim
publish_one packages/firecrawl-shim
publish_one packages/stagehand-shim

echo
echo "✅ All three shims published. Verify:"
echo "   npm view @unbrowse/playwright-shim version"
echo "   npm view @unbrowse/firecrawl-shim version"
echo "   npm view @unbrowse/stagehand-shim version"
