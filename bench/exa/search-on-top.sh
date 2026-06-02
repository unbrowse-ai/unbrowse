#!/usr/bin/env bash
# search-on-top.sh — benchmark probe for the unified search-on-top surface.
# Runs `unbrowse search` for a set of intents and records, per intent: latency,
# whether a route-graph hit answered it (free/cheap) vs a paid web-search
# fallback, and the result count. Writes a JSONL row per intent so the result is
# a real measurement, not a claim.
#
# Usage: bash bench/exa/search-on-top.sh [out.jsonl]
# Env:   UNBROWSE_BIN (default: `bun src/cli.ts`), UNBROWSE_API_KEY
set -uo pipefail
REPO="$(cd "$(dirname "$0")/../.." && pwd)"; cd "$REPO"
OUT="${1:-bench/exa/.artifacts/search-on-top.jsonl}"
mkdir -p "$(dirname "$OUT")"; : > "$OUT"
BIN="${UNBROWSE_BIN:-bun src/cli.ts}"

INTENTS=(
  "best machine learning frameworks"
  "list a github user's repositories"
  "search hacker news for AI agents"
  "current weather in Singapore"
  "find a route to read a google calendar"
)

echo "[search-on-top] probing ${#INTENTS[@]} intents -> $OUT"
for intent in "${INTENTS[@]}"; do
  start=$(date +%s%3N 2>/dev/null || python3 -c 'import time;print(int(time.time()*1000))')
  raw="$($BIN search --intent "$intent" --json 2>/dev/null || true)"
  end=$(date +%s%3N 2>/dev/null || python3 -c 'import time;print(int(time.time()*1000))')
  ms=$(( end - start ))
  # count results + detect whether a paid web fallback was used (best-effort,
  # from the JSON the CLI prints). The agent judges the artifact; no heuristic
  # pass/fail here.
  n=$(printf '%s' "$raw" | grep -oE '"endpoint_id"|"url"' | wc -l | tr -d ' ')
  paid=$(printf '%s' "$raw" | grep -qiE '"source"\s*:\s*"(web|exa)"|"paid"\s*:\s*true' && echo true || echo false)
  printf '{"intent":%s,"latency_ms":%d,"result_signals":%d,"paid_fallback":%s}\n' \
    "$(printf '%s' "$intent" | python3 -c 'import json,sys;print(json.dumps(sys.stdin.read()))')" \
    "$ms" "$n" "$paid" >> "$OUT"
  echo "  · ${intent} — ${ms}ms, ${n} signals, paid_fallback=${paid}"
done
echo "[search-on-top] wrote $(wc -l < "$OUT" | tr -d ' ') rows to $OUT"
echo "[search-on-top] artifact is for agent judgement — no heuristic verdict."
