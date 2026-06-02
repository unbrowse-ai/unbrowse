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
  # Minify by default: drops the embedded bundle ~5.0M -> ~2.8M (binary 78M -> 75M)
  # with no runtime change (verified: minified binary boots + parses CLI). Set
  # UNBROWSE_BUILD_MINIFY=0 to opt out (e.g. for readable stack traces in a debug
  # build).
  if [ "${UNBROWSE_BUILD_MINIFY:-1}" != "0" ]; then
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
  # win-x64 added 2026-05-26 — Bun's `--target=bun-windows-x64` cross-
  # compiles the JS bundle on any host. SUPPORTED_TARGETS in
  # release-assets.mjs now includes win-x64; install.mjs resolves it;
  # verify-release-assets.mjs checks it. Kuri.exe is staged separately
  # by the kuri-windows-cross-build workflow + build-kuri-binaries.mjs.
  build_target "win-x64"
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
