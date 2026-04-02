#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
IMAGE_TAG="${IMAGE_TAG:-kuri-bench:local}"
PROFILE="${PROFILE:-medium}"
URL="${1:-https://vercel.com}"

case "$PROFILE" in
  small)
    CPUS="${CPUS:-1}"
    MEMORY="${MEMORY:-2g}"
    SHM_SIZE="${SHM_SIZE:-1g}"
    ;;
  medium)
    CPUS="${CPUS:-2}"
    MEMORY="${MEMORY:-4g}"
    SHM_SIZE="${SHM_SIZE:-2g}"
    ;;
  large)
    CPUS="${CPUS:-4}"
    MEMORY="${MEMORY:-8g}"
    SHM_SIZE="${SHM_SIZE:-4g}"
    ;;
  *)
    echo "unknown PROFILE=$PROFILE (expected: small, medium, large)" >&2
    exit 1
    ;;
esac

docker build -f "$ROOT_DIR/benchmarks/Dockerfile" -t "$IMAGE_TAG" "$ROOT_DIR"

docker run --rm \
  --cpus="$CPUS" \
  --memory="$MEMORY" \
  --shm-size="$SHM_SIZE" \
  -e RESULTS_ROOT=/workspace/.benchmarks/results \
  -v "$ROOT_DIR:/workspace" \
  "$IMAGE_TAG" \
  "$URL"
