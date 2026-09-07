#!/usr/bin/env bash
# Rebuild the unbrowse-core Zig WASM and copy it into the CLI.
#
# The single Zig core (../../unbrowse-core) is the canonical implementation of
# declare canonicalization + ed25519 sign/verify (and zk). `zig build wasm`
# emits a wasm32-freestanding reactor; we copy it to src/wasm/unbrowse_core.wasm
# where src/lib/core-wasm.ts imports it. The committed .wasm is the source of
# truth for the shipped CLI; this script reproduces it byte-for-byte from the
# Zig source. It is byte-identical to backend/src/wasm/unbrowse_core.wasm — the
# two callers (CLI producer, backend verifier) share ONE core.
#
# Usage: bash scripts/build-core-wasm.sh   (from the CLI repo root)
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CLI_DIR="$(cd "$HERE/.." && pwd)"
CORE_DIR="$(cd "$CLI_DIR/../unbrowse-core" && pwd)"
DEST="$CLI_DIR/src/wasm/unbrowse_core.wasm"

if ! command -v zig >/dev/null 2>&1; then
  echo "error: zig not on PATH — install Zig 0.16.0 to rebuild the core wasm" >&2
  exit 1
fi

echo "building unbrowse-core wasm in $CORE_DIR ..."
( cd "$CORE_DIR" && zig build wasm )

SRC="$CORE_DIR/unbrowse_core.wasm"
[ -f "$SRC" ] || SRC="$CORE_DIR/zig-out/bin/unbrowse_core.wasm"
[ -f "$SRC" ] || { echo "error: built wasm not found in $CORE_DIR" >&2; exit 1; }

mkdir -p "$CLI_DIR/src/wasm"
cp "$SRC" "$DEST"
echo "copied -> $DEST"
shasum -a 256 "$DEST"
