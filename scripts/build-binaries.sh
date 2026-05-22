#!/bin/bash
set -euo pipefail

# Build platform-specific single binaries with kuri embedded.
# Output:
#   dist/unbrowse-{platform}-{arch}
#   dist/unbrowse-vX.Y.Z-{platform}-{arch}.tar.gz
#
# Usage:
#   ./scripts/build-binaries.sh          # build for current platform
#   ./scripts/build-binaries.sh --all    # cross-compile all 4 platforms

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
ROOT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
DIST_DIR="$ROOT_DIR/dist"
VERSION_TAG="${UNBROWSE_RELEASE_TAG:-v$(grep -m1 '"version"' "$ROOT_DIR/package.json" | sed -E 's/.*"version": "([^"]+)".*/\1/')}"

mkdir -p "$DIST_DIR"
eval "$(bun "$ROOT_DIR/scripts/build-release-manifest.ts" --shell-env)"

# Ensure vendored kuri binaries exist for all 4 targets before bun bundles
# them in via `with { type: "file" }` imports. Targets that can't be
# cross-compiled from this host get a placeholder stub so the bundling step
# resolves; users on those platforms see a clear error at runtime.
echo "[build] ensuring kuri vendor binaries (build-kuri-binaries.mjs)"
node "$ROOT_DIR/packages/skill/scripts/build-kuri-binaries.mjs"

# Build @unbrowse/sdk before the bun bundle below. src/payments/flex-pay.ts
# imports "@unbrowse/sdk", whose package.json exports point at dist/ -- and
# dist/ is gitignored. On a fresh CI checkout dist/ does not exist; once
# `bun install` has created node_modules/@unbrowse/sdk as a real symlink,
# `bun build src/single-binary.ts` resolves the import through that
# package.json exports map, hits the missing dist/index.js, and fails with
# "Could not resolve: @unbrowse/sdk". (It only appears to work on a dev
# machine whose bun install aborted before linking the symlink, because bun
# then falls back to workspace->src resolution.) Build the SDK here so the
# dist/ entry exists and the bundle resolves deterministically.
echo "[build] building @unbrowse/sdk (CLI bundles it; dist/ is gitignored)"
# Clean any stale dist/ + incremental tsc state before building. On a
# persistent self-hosted runner a lingering .tsbuildinfo makes
# `tsc -p tsconfig.json` no-op ("already built") while dist/ is absent,
# so dist/index.js is never produced -- the leading suspect for the
# release failing on CI but not on an ephemeral dev machine.
( cd "$ROOT_DIR/packages/sdk" && rm -rf dist tsconfig.tsbuildinfo .tsbuildinfo *.tsbuildinfo 2>/dev/null; bun run build )
# Hard post-build assertion + disk-state dump. The release pipeline has
# failed three times with "Could not resolve @unbrowse/sdk" at the bun
# bundle step despite this build running; the failure does not reproduce
# on a dev machine even under the reconstructed CI condition. Make the
# truth legible: confirm the dist entry the package.json exports map
# points at actually exists, and dump what is on disk so a CI failure
# shows the real state instead of only the downstream resolve error.
echo "[build] @unbrowse/sdk post-build disk state:"
ls -la "$ROOT_DIR/packages/sdk/dist" 2>&1 || echo "  (no dist/ dir)"
ls -la "$ROOT_DIR/node_modules/@unbrowse/sdk" 2>&1 || echo "  (no node_modules/@unbrowse/sdk)"
if [ ! -f "$ROOT_DIR/packages/sdk/dist/index.js" ]; then
  echo "[build] FATAL: @unbrowse/sdk build produced no dist/index.js — the CLI bundle cannot resolve @unbrowse/sdk"
  exit 1
fi
echo "[build] @unbrowse/sdk dist/index.js OK ($(wc -c < "$ROOT_DIR/packages/sdk/dist/index.js") bytes)"

build_target() {
  local target="$1" # e.g. darwin-arm64, win-x64
  local ext=""
  [[ "$target" == win-* ]] && ext=".exe"
  local outfile="$DIST_DIR/unbrowse-$target$ext"
  local archive="$DIST_DIR/unbrowse-$VERSION_TAG-$target.tar.gz"
  local bun_target="bun-$target"
  # Bun uses "windows" not "win" in target names
  bun_target="${bun_target/bun-win-/bun-windows-}"
  local tmpdir

  echo "[build] $target -> $outfile"
  local build_args=(
    "$ROOT_DIR/src/single-binary.ts"
    --compile
    --target="$bun_target"
    --outfile "$outfile"
  )
  if [ "${UNBROWSE_BUILD_MINIFY:-0}" = "1" ]; then
    build_args+=(--minify)
  fi
  bun build "${build_args[@]}" 2>&1

  local size=$(ls -lh "$outfile" | awk '{print $5}')
  echo "[build] $target done ($size)"

  tmpdir="$(mktemp -d)"
  local archive_name="unbrowse$ext"
  cp "$outfile" "$tmpdir/$archive_name"
  tar -czf "$archive" -C "$tmpdir" "$archive_name"
  rm -rf "$tmpdir"
  echo "[build] packaged $archive"
}

if [ "${1:-}" = "--all" ]; then
  build_target "darwin-arm64"
  build_target "darwin-x64"
  build_target "linux-arm64"
  build_target "linux-x64"
  # win-x64 intentionally skipped — not in packages/skill/scripts/release-assets.mjs
  # SUPPORTED_TARGETS, install.mjs never resolves it, verify-release-assets.mjs
  # never checks it. Building+uploading saves ~95MB / release. Re-add when Windows
  # is added to SUPPORTED_TARGETS.
  echo "[build] all platforms built:"
  ls -lh "$DIST_DIR"/unbrowse-*
else
  # Current platform only
  PLATFORM="$(uname -s | tr '[:upper:]' '[:lower:]')"
  ARCH="$(uname -m)"
  [ "$ARCH" = "aarch64" ] && ARCH="arm64"
  [ "$ARCH" = "x86_64" ] && ARCH="x64"
  TARGET="$PLATFORM-$ARCH"
  build_target "$TARGET"
  # Also create a convenience symlink
  ln -sf "unbrowse-$TARGET" "$DIST_DIR/unbrowse"
  echo "[build] symlinked dist/unbrowse -> unbrowse-$TARGET"
fi
