#!/usr/bin/env bash
# search-warm-gate — the witness that the signature-keyed resolution cache makes a
# REPEATED search/resolve fast: the second identical query replays the cached pointer
# instead of re-paying the backend's discovery + web-search enrichment.
#
# Runs the REAL binary twice for the same intent and reads real wall-clock. Exit 0 iff
# the warm call is materially faster than the cold call (warm < cold/2) AND returns the
# identical result (correctness — caching must not change the answer).
#
# Needs UNBROWSE_API_KEY. The remaining warm latency is CLI/process cold-start, not
# search; the resident MCP/server path is faster still.
set -uo pipefail
REPO="$(cd "$(dirname "$0")/../.." && pwd)"; cd "$REPO"
set -a; . ./.env 2>/dev/null || true; set +a
BIN="${UNBROWSE_BIN:-bun src/cli.ts}"
Q="${1:-best rust web frameworks 2026}"

[ -n "${UNBROWSE_API_KEY:-}" ] || { echo "[warm-gate] FAIL — UNBROWSE_API_KEY absent"; exit 1; }

rm -rf "$HOME/.unbrowse/resolution-cache"   # start cold
ms() { python3 -c 'import time;print(int(time.time()*1000))'; }

t0=$(ms); timeout 90 $BIN resolve --intent "$Q" --json > /tmp/warm-gate-cold.json 2>/dev/null; t1=$(ms)
t2=$(ms); timeout 90 $BIN resolve --intent "$Q" --json > /tmp/warm-gate-warm.json 2>/dev/null; t3=$(ms)
cold=$((t1-t0)); warm=$((t3-t2))
echo "[warm-gate] cold=${cold}ms  warm=${warm}ms"

if ! cmp -s /tmp/warm-gate-cold.json /tmp/warm-gate-warm.json; then
  echo "[warm-gate] FAIL — warm result differs from cold (caching changed the answer)"; exit 1
fi
# Two gates: (1) materially faster than cold, and (2) below the app-boot floor — a
# fresh hit must short-circuit BEFORE the in-process backend boots (~4s). 4000ms ceiling
# catches a regression where a cache hit re-boots the app.
WARM_CEILING_MS="${WARM_CEILING_MS:-4000}"
if [ "$cold" -le 0 ] || [ "$((warm*2))" -ge "$cold" ]; then
  echo "[warm-gate] NOT YET — warm (${warm}ms) not < cold/2 (${cold}ms). Cache miss?"; exit 1
fi
if [ "$warm" -ge "$WARM_CEILING_MS" ]; then
  echo "[warm-gate] NOT YET — warm (${warm}ms) >= ${WARM_CEILING_MS}ms ceiling; the hit is likely still booting the app."; exit 1
fi
echo "[warm-gate] PASS — warm replay ${warm}ms (< cold/2 ${cold}ms, < ${WARM_CEILING_MS}ms floor), identical result. Repeated search beats a cold app boot."
