#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")/.."

bun test --timeout 30000 \
  tests/cardinality.test.ts \
  tests/resolve-probe-html-direct-document.test.ts \
  tests/orchestrator-autowalk.test.ts \
  tests/kuri-port-selection.test.ts \
  tests/unbrowse-testing-u4.test.ts \
  tests/capture-performance-replay.test.ts \
  tests/protobuf-wire.test.ts \
  tests/reveng-local-inference.test.ts \
  tests/reveng-server-first.test.ts

if [[ "${UNBROWSE_SKIP_LIVE_MCF:-0}" == "1" ]]; then
  exit 0
fi

out="$(mktemp)"
trap 'rm -f "$out"' EXIT
export UNBROWSE_DISABLE_AUTO_UPDATE=1
export UNBROWSE_NON_INTERACTIVE=1
export UNBROWSE_TOS_ACCEPTED=1

timeout 120s bun src/cli.ts capture \
  --url "https://www.mycareersfuture.gov.sg/search?search=AI%20software%20engineer&sortBy=new_posting_date&page=0" \
  --intent "find exactly 10 recent AI software engineering jobs with structured title company salary location posted date and job URL" \
  --pretty >"$out" 2>&1

rg -q '"endpoints_discovered": [1-9][0-9]*' "$out"
rg -q 'api\.mycareersfuture\.gov\.sg/v2/search' "$out"
if rg -q '"error": "no_endpoints"' "$out"; then
  sed -n '1,240p' "$out"
  exit 1
fi

sed -n '/"endpoints_discovered"/,$p' "$out" | sed -n '1,80p'
