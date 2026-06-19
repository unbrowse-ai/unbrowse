#!/usr/bin/env bash
# Witness: CLI cold-start floor. Median of 3 `--help` invocations must beat the
# threshold (default 900ms) — well under Exa's 1459ms median so a warm cache-hit
# search (startup + ~6ms cache replay) can beat Exa via the subprocess path.
set -uo pipefail
BIN="${UNBROWSE_BIN:-bun src/cli.ts}"
THRESH="${STARTUP_THRESHOLD_MS:-900}"
ms() { local t0; t0=$(python3 -c 'import time;print(time.time())'); $BIN --help >/dev/null 2>&1; python3 -c "import time;print(int((time.time()-$t0)*1000))"; }
a=$(ms); b=$(ms); c=$(ms)
med=$(printf '%s\n' "$a" "$b" "$c" | sort -n | sed -n 2p)
echo "[startup] --help runs: ${a}ms ${b}ms ${c}ms  → median ${med}ms (threshold ${THRESH}ms)"
[ "$med" -lt "$THRESH" ] && { echo "[startup] PASS"; exit 0; } || { echo "[startup] FAIL — too heavy"; exit 1; }
