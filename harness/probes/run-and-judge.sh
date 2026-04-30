#!/usr/bin/env bash
# run-and-judge.sh — orchestrates the harness-as-default agent-experience flow.
# Runs the probe corpus, then prints exact instructions for invoking the LLM
# judge against the resulting manifest. Per CLAUDE.md "harness collects, agent
# judges" — the verdict is rendered in-thread by an LLM reading manifest.json
# against harness/probes/JUDGE.md, NOT by regex/grep here.
set -uo pipefail
REPO="$(cd "$(dirname "$0")/../.." && pwd)"
RUN_OUT=$(bash "$REPO/harness/probes/agent-experience.sh" "$@" 2>&1 | tee /dev/stderr | tail -n 5)
MANIFEST=$(echo "$RUN_OUT" | grep -oE "$REPO/harness/runs/[^ ]+/manifest.json" | tail -1)
if [ -z "$MANIFEST" ] || [ ! -f "$MANIFEST" ]; then
  echo "[run-and-judge] FAIL: manifest not found" >&2
  exit 1
fi
echo
echo "============================================================"
echo "[run-and-judge] Manifest ready: $MANIFEST"
echo
echo "Hand to LLM judge:"
echo
echo "  Agent({"
echo "    description: \"Judge harness manifest\","
echo "    prompt: \"Read $MANIFEST and apply the protocol in $REPO/harness/probes/JUDGE.md. Return per-probe verdicts and run-level summary as JSON.\""
echo "  })"
echo
echo "Or read directly:"
echo "  cat $MANIFEST | head -200"
echo "============================================================"
