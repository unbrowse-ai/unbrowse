#!/usr/bin/env bash
# publish-dropins.sh — build + publish the drop-in family to npm (idempotent).
#
# Used by .github/workflows/publish-dropins.yml (CI) AND for the one-time local
# bootstrap: the FIRST publish of a brand-new @unbrowse/*-shim name needs a
# maintainer login with 2FA, because granular automation tokens 404 on PUT for
# names that don't exist yet. Run it once locally to create the names; after that
# CI cuts every version with the org token.
#
#   npm login                              # once, as a getfoundry @unbrowse maintainer
#   bash scripts/publish-dropins.sh         # publish each at its package.json version
#   bash scripts/publish-dropins.sh dry-run # npm publish --dry-run only
#
# Idempotent: a version already on the registry is skipped, never re-published.
# No --provenance: the source repo (unbrowse-dev) is private and npm rejects
# provenance bundles from a private source (mirrors release.yml).

set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
DRY="${1:-}"

PKGS=(axios-shim got-shim ky-shim node-fetch-shim cross-fetch-shim \
      puppeteer-shim playwright-shim firecrawl-shim stagehand-shim adopt)

publish_one() {
  local dir="$ROOT/packages/$1"
  local name version published
  name="$(node -p "require('$dir/package.json').name")"
  version="$(node -p "require('$dir/package.json').version")"
  echo
  echo "=== $name@$version ==="
  ( cd "$dir" && npm run build )

  # idempotency: skip if this exact version is already on the registry
  published="$(npm view "$name@$version" version 2>/dev/null || true)"
  if [[ "$published" == "$version" ]]; then
    echo "already published — skipping."
    return 0
  fi

  if [[ "$DRY" == "dry-run" ]]; then
    ( cd "$dir" && npm publish --access public --dry-run )
  else
    ( cd "$dir" && npm publish --access public )
  fi
}

for p in "${PKGS[@]}"; do publish_one "$p"; done

echo
echo "Done. Verify: npm view @unbrowse/axios-shim version"
