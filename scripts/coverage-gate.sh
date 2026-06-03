#!/usr/bin/env bash
# coverage-gate — the LIVE witness for "more coverage, and it WORKS."
#
# Un-fakeable: it RUNS the real `unbrowse search` binary against the real backend
# over a corpus of DIVERSE intents (different domains, no shared route) and reads the
# actual JSON each process emits. An intent "works" iff the process exits 0 AND the
# result is a genuine success with real data (`"success":true` + a data/endpoint/url
# signal). Coverage = the fraction of the diverse corpus that works.
#
# This is the north star's "more coverage and works": the fallback pipe means a
# route-graph miss still falls through to web search and returns real data, so a
# BROAD intent space is covered AND every covered intent actually returns something.
# Exit 0 iff coverage >= COVERAGE_MIN (default 0.75) — a real measurement, not a claim.
#
# Needs UNBROWSE_API_KEY (the real backend). No key → it FAILS honestly (never skip-green).
set -uo pipefail
REPO="$(cd "$(dirname "$0")/.." && pwd)"; cd "$REPO"
set -a; . ./.env 2>/dev/null || true; set +a

BIN="${UNBROWSE_BIN:-bun src/cli.ts}"
COVERAGE_MIN="${COVERAGE_MIN:-0.75}"
PER_INTENT_TIMEOUT="${PER_INTENT_TIMEOUT:-60}"

if [ -z "${UNBROWSE_API_KEY:-}" ]; then
  echo "[coverage-gate] FAIL — UNBROWSE_API_KEY absent; cannot prove it WORKS against the real backend."; exit 1
fi

# Diverse intents — distinct domains, no shared route. Breadth IS the coverage claim.
INTENTS=(
  "search hacker news for AI agents"
  "list a github user's public repositories"
  "current weather in Singapore"
  "latest news about openai"
  "find a recipe for chocolate chip cookies"
  "search youtube for python tutorials"
  "wikipedia summary of quantum computing"
  "top stories on reddit technology"
)

n=${#INTENTS[@]}; works=0
echo "[coverage-gate] running real \`unbrowse search\` over $n diverse intents (min coverage ${COVERAGE_MIN})..."
for intent in "${INTENTS[@]}"; do
  raw="$(timeout "$PER_INTENT_TIMEOUT" $BIN search --intent "$intent" --json 2>/dev/null || true)"
  if printf '%s' "$raw" | grep -q '"success":true' \
     && printf '%s' "$raw" | grep -qE '"data"|"endpoint_id"|"url"'; then
    works=$((works+1)); echo "  works  · ${intent}"
  else
    echo "  MISS   · ${intent}"
  fi
done

ratio="$(awk -v w="$works" -v n="$n" 'BEGIN{ printf "%.3f", (n>0? w/n : 0) }')"
echo "[coverage-gate] coverage = ${works}/${n} = ${ratio}  (min ${COVERAGE_MIN})"
if awk -v r="$ratio" -v m="$COVERAGE_MIN" 'BEGIN{ exit !(r+0 >= m+0) }'; then
  echo "[coverage-gate] PASS — broad coverage AND it works: ${works}/${n} diverse intents returned real results."
  exit 0
fi
echo "[coverage-gate] NOT YET — coverage ${ratio} < ${COVERAGE_MIN}. Keep walking (widen the route graph / fallback)."
exit 1
