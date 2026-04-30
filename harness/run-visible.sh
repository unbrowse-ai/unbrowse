#!/usr/bin/env bash
# Harness #2 — Run Visible: dev-empathy entrypoint that runs a step with HEADLESS=false.
# Usage: harness/run-visible.sh --intent "<intent>" --url "<url>"
set -euo pipefail

INTENT=""
URL=""
while [ $# -gt 0 ]; do
  case "$1" in
    --intent) INTENT="${2:?--intent requires a value}"; shift 2 ;;
    --url)    URL="${2:?--url requires a value}"; shift 2 ;;
    -h|--help)
      echo "Usage: harness/run-visible.sh --intent \"<intent>\" --url \"<url>\""
      exit 0 ;;
    *) echo "[run-visible] unknown arg: $1" >&2; exit 2 ;;
  esac
done

[ -n "$INTENT" ] || { echo "Usage: harness/run-visible.sh --intent \"<intent>\" --url \"<url>\"" >&2; exit 2; }
[ -n "$URL" ]    || { echo "Usage: harness/run-visible.sh --intent \"<intent>\" --url \"<url>\"" >&2; exit 2; }

TIMESTAMP=$(date -u +"%Y-%m-%dT%H-%M-%SZ")
RAND=$(head -c 4 /dev/urandom | od -An -tx1 | tr -d ' \n')
RUN_ID="${TIMESTAMP}-${RAND}"
ARTIFACT_DIR=".harness-out/${RUN_ID}"
mkdir -p "$ARTIFACT_DIR"

echo "[run-visible] run_id:      $RUN_ID"
echo "[run-visible] artifact_dir: $ARTIFACT_DIR"
echo "[run-visible] intent:      $INTENT"
echo "[run-visible] url:         $URL"
echo "[run-visible] HEADLESS=false (visible mode)"

# HEADLESS=false is prepended (not exported globally) so it scopes to this child only.
HEADLESS=false UNBROWSE_DEV_VISIBLE=1 \
  bun harness/visible-step.ts \
    --intent "$INTENT" \
    --url "$URL" \
    --run-id "$RUN_ID"
