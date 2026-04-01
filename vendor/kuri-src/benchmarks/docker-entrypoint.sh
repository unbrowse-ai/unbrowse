#!/usr/bin/env bash
set -euo pipefail

cd /workspace

export CHROME_BIN="${CHROME_BIN:-/usr/bin/chromium}"
export LIGHTPANDA_BIN="${LIGHTPANDA_BIN:-/usr/local/bin/lightpanda}"
export RESULTS_ROOT="${RESULTS_ROOT:-/workspace/.benchmarks/results}"
mkdir -p "$RESULTS_ROOT"

# Always rebuild in-container so Linux doesn't try to reuse a host Mach-O binary.
zig build -Doptimize=ReleaseFast

if ! curl -fsS http://127.0.0.1:9222/json >/dev/null 2>&1; then
  "$CHROME_BIN" \
    --headless=new \
    --disable-gpu \
    --disable-dev-shm-usage \
    --no-sandbox \
    --remote-debugging-address=127.0.0.1 \
    --remote-debugging-port=9222 \
    about:blank >/tmp/chromium-bench.log 2>&1 &

  for _ in $(seq 1 50); do
    if curl -fsS http://127.0.0.1:9222/json >/dev/null 2>&1; then
      break
    fi
    sleep 0.2
  done
fi

exec bash ./benchmarks/run_token_matrix.sh "$@"
