#!/usr/bin/env bash
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"
for target in protobuf-wire obscura-capture rsc; do
  echo "[fuzz-smoke] $target"
  bash scripts/run-fuzz.sh "$target" -runs="${FUZZ_SMOKE_RUNS:-1000}"
done
