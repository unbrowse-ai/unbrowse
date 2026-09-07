#!/usr/bin/env bash
# Rebuild the unbrowse-core Zig WASM and copy it into the backend.
#
# The single Zig core (../../../unbrowse-core) is the canonical implementation
# of declare canonicalization (and sign/verify/zk). `zig build wasm` emits a
# wasm32-freestanding reactor; we copy it to src/wasm/unbrowse_core.wasm where
# core-wasm.ts imports it. The committed .wasm is the source of truth for prod;
# this script reproduces it byte-for-byte from the Zig source.
#
# Usage: bun run build:core-wasm   (from backend/)
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
BACKEND_DIR="$(cd "$HERE/.." && pwd)"
CORE_DIR="$(cd "$BACKEND_DIR/../../unbrowse-core" && pwd)"
DEST="$BACKEND_DIR/src/wasm/unbrowse_core.wasm"

if ! command -v zig >/dev/null 2>&1; then
  echo "error: zig not on PATH — install Zig 0.16.0 to rebuild the core wasm" >&2
  exit 1
fi

echo "building unbrowse-core wasm in $CORE_DIR ..."
( cd "$CORE_DIR" && zig build wasm )

SRC="$CORE_DIR/unbrowse_core.wasm"
[ -f "$SRC" ] || SRC="$CORE_DIR/zig-out/bin/unbrowse_core.wasm"
[ -f "$SRC" ] || { echo "error: built wasm not found in $CORE_DIR" >&2; exit 1; }

mkdir -p "$BACKEND_DIR/src/wasm"
cp "$SRC" "$DEST"
echo "copied -> $DEST"
shasum -a 256 "$DEST"
