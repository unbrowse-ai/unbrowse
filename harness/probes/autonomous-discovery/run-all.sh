#!/usr/bin/env bash
# Orchestrator — runs probes A, B, C in sequence and writes a manifest the
# agent can read to judge.
#
# Usage:
#   bash harness/probes/autonomous-discovery/run-all.sh
#   bash harness/probes/autonomous-discovery/run-all.sh --only a
#   bash harness/probes/autonomous-discovery/run-all.sh --intent "..." --url "..."
#
# Per CLAUDE.md "harness collects, agent judges": this script never returns
# pass/fail. Always exits 0 unless the harness itself crashes. The agent
# reads .harness-out/autonomous-discovery/<run-id>/manifest.json + verdict.md.

set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
# shellcheck disable=SC1091
source "${SCRIPT_DIR}/lib.sh"

ONLY=""
INTENT="search emails for dog food"
URL="https://jmail.world/search?q=dog+food"

while [ $# -gt 0 ]; do
  case "$1" in
    --only)   ONLY="$2"; shift 2 ;;
    --intent) INTENT="$2"; shift 2 ;;
    --url)    URL="$2"; shift 2 ;;
    *) echo "unknown arg: $1" >&2; exit 2 ;;
  esac
done

write_manifest_header

echo "[run-all] run_id=$RUN_ID"
echo "[run-all] out=$OUT_DIR"
echo "[run-all] intent=$INTENT"
echo "[run-all] url=$URL"
echo

run_probe() {
  local letter="$1"
  if [ -n "$ONLY" ] && [ "$ONLY" != "$letter" ]; then return 0; fi
  local script="${SCRIPT_DIR}/probe-${letter}-"*".sh"
  for s in $script; do
    if [ -x "$s" ]; then
      echo "[run-all] === probe $letter ==="
      bash "$s" "$INTENT" "$URL" || true
      echo
    fi
  done
}

run_probe "a"
run_probe "b"
run_probe "c"

echo "[run-all] manifest: $OUT_DIR/manifest.json"
echo
echo "Next: judge the artifacts in-thread (see JUDGE.md), then write"
echo "       $OUT_DIR/verdict.md"
