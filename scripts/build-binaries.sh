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

build_target() {
  local target="$1" # e.g. darwin-arm64
  local outfile="$DIST_DIR/unbrowse-$target"
  local archive="$DIST_DIR/unbrowse-$VERSION_TAG-$target.tar.gz"
  local tmpdir

  echo "[build] $target -> $outfile"
  bun build "$ROOT_DIR/src/single-binary.ts" \
    --compile \
    --minify \
    --target="bun-$target" \
    --outfile "$outfile" 2>&1

  local size=$(ls -lh "$outfile" | awk '{print $5}')
  echo "[build] $target done ($size)"

  tmpdir="$(mktemp -d)"
  cp "$outfile" "$tmpdir/unbrowse"
  tar -czf "$archive" -C "$tmpdir" unbrowse
  rm -rf "$tmpdir"
  echo "[build] packaged $archive"
}

if [ "${1:-}" = "--all" ]; then
  build_target "darwin-arm64"
  build_target "darwin-x64"
  build_target "linux-arm64"
  build_target "linux-x64"
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
