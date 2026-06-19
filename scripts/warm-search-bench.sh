#!/usr/bin/env bash
# Witness: warm (cache-hit) `unbrowse search` wall-clock must beat Exa's median
# (1459ms). Warms the cache once, then medians 3 warm runs.
set -uo pipefail
BIN="${UNBROWSE_BIN:-bun src/cli.ts}"
THRESH="${WARM_THRESHOLD_MS:-1459}"
Q="${1:-best AI agent frameworks}"
$BIN search --intent "$Q" --json >/dev/null 2>&1   # warm the cache
ms() { local t0; t0=$(python3 -c 'import time;print(time.time())'); $BIN search --intent "$Q" --json >/dev/null 2>&1; python3 -c "import time;print(int((time.time()-$t0)*1000))"; }
a=$(ms); b=$(ms); c=$(ms)
med=$(printf '%s\n' "$a" "$b" "$c" | sort -n | sed -n 2p)
echo "[warm-search] runs: ${a}ms ${b}ms ${c}ms → median ${med}ms (beat Exa ${THRESH}ms)"
[ "$med" -lt "$THRESH" ] && { echo "[warm-search] PASS"; exit 0; } || { echo "[warm-search] FAIL"; exit 1; }
