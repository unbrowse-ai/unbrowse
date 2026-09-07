#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

bun test --timeout 30000 \
  tests/capture-exploration-planner.test.ts \
  tests/action-provenance.test.ts \
  tests/reveng-post-body-replay.test.ts \
  tests/query-hook-bridge.test.ts

if [[ "${UNBROWSE_SKIP_LIVE_ACTION_WITNESS:-0}" == "1" ]]; then
  exit 0
fi

export UNBROWSE_DISABLE_AUTO_UPDATE=1
export UNBROWSE_NON_INTERACTIVE=1
export UNBROWSE_TOS_ACCEPTED=1

CAPTURE_OUT="${UNBROWSE_ACTION_WITNESS_CAPTURE:-/tmp/unbrowse-action-witness-capture.jsonlog}"
REPLAY_OUT="${UNBROWSE_ACTION_WITNESS_REPLAY:-/tmp/unbrowse-action-witness-replay.jsonlog}"
WITNESS_URL="https://www.mycareersfuture.gov.sg/search?search=AI%20software%20engineer&sortBy=new_posting_date&page=0"

if [[ "${UNBROWSE_ACTION_WITNESS_REUSE:-0}" != "1" || ! -s "$CAPTURE_OUT" ]]; then
  timeout 150s bun src/cli.ts capture \
    --url "$WITNESS_URL" \
    --intent "find recent AI software engineering jobs" \
    --pretty >"$CAPTURE_OUT" 2>&1
fi

grep -q 'explore pagination' "$CAPTURE_OUT"
grep -q '"actions_succeeded": 1' "$CAPTURE_OUT"
grep -Eq '"causal_api_deltas": ([1-9][0-9]*)' "$CAPTURE_OUT"
grep -q 'api.mycareersfuture.gov.sg/v2/search?limit=20&page=1' "$CAPTURE_OUT"

SKILL_ID="$(grep -o '"skill_id": "[^"]*' "$CAPTURE_OUT" | tail -1 | cut -d'"' -f4)"
ENDPOINT_ID="$(jq -r '.endpoints[] | select(.url_template | contains("/v2/search")) | .endpoint_id' "$HOME/.unbrowse/skill-cache/$SKILL_ID.json")"
jq -e '.endpoints[] | select(.url_template | contains("/v2/search")) | .body.search == "ai software engineer"' \
  "$HOME/.unbrowse/skill-cache/$SKILL_ID.json" >/dev/null

# The transport/API witness is independent from the optional trace-ledger
# receipt: require a real 200 response containing structured job records even
# when a local machine cannot append the ancillary signed trace.
set +e
bun src/cli.ts execute --skill "$SKILL_ID" --endpoint "$ENDPOINT_ID" \
  -p limit=10 -p page=0 --pretty >"$REPLAY_OUT" 2>&1
REPLAY_EXIT=$?
set -e
grep -q '"status": 200' "$REPLAY_OUT"
grep -q 'results' "$REPLAY_OUT"
grep -q 'AI Enablement Developer\|Software Engineer' "$REPLAY_OUT"

if command -v lsof >/dev/null; then
  ! lsof -nP -iTCP:7701 -sTCP:LISTEN | grep -q kuri
fi

printf 'action-driven capture witness passed (execute exit=%s; HTTP/API replay witnessed)\n' "$REPLAY_EXIT"
