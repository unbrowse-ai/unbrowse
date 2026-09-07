#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
TARGET="${1:-protobuf-wire}"
shift || true

case "$TARGET" in
  protobuf-wire|obscura-capture|rsc) ;;
  *) echo "unknown fuzz target: $TARGET" >&2; exit 2 ;;
esac

cd "$ROOT"
mkdir -p ".fuzz-build" "fuzz/corpus/$TARGET"
bun build "fuzz/$TARGET.fuzz.ts"   --outfile ".fuzz-build/$TARGET.fuzz.mjs"   --target node   --format esm   --sourcemap=inline

exec ./node_modules/.bin/jazzer   ".fuzz-build/$TARGET.fuzz.mjs"   --sync   --instrumentation_includes=".fuzz-build/$TARGET.fuzz.mjs"   "fuzz/corpus/$TARGET"   "fuzz/seeds/$TARGET"   -- -max_len=65536 "$@"
