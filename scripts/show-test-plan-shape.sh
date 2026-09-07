#!/usr/bin/env bash
# show-test-plan-shape.sh
#
# VIEWER (not judge) for docs/disposable-mcp-test-plan.md.
#
# Prints, for each `## Layer N` heading, the sub-headings underneath it
# (`### Setup`, `### Run`, `### Evidence`, `### Agent judges`) and every
# `echo "…"` line inside the layer's range. The agent reading the output
# judges whether each layer obeys the firmament template (four sub-
# headings present, no `cmd && echo "OK" || echo "BAD"` shapes inside
# fenced bash blocks).
#
# Why a viewer, not a judge:
#   feedback_harness_makes_visible_agent_judges.md — the harness's only
#   job is to make evidence visible. Classifying lines as "verdict" vs
#   "label" requires reading the surrounding bash semantics, which is a
#   judging-agent's job, not a script's. This file just flattens the
#   data so the agent can scan by eye.
#
# Usage:
#   bash scripts/show-test-plan-shape.sh
#
# Exit code: always 0. The viewer doesn't fail; the agent decides.

set -u

DOC="${1:-docs/disposable-mcp-test-plan.md}"

if [ ! -f "$DOC" ]; then
  echo "viewer: file not found: $DOC"
  exit 0
fi

# Collect the line numbers where each `## ` heading starts.
LAYER_LINES=()
while IFS= read -r line; do
  LAYER_LINES+=("$line")
done < <(grep -nE '^## ' "$DOC" | cut -d: -f1)
TOTAL_LINES=$(wc -l < "$DOC")

for i in "${!LAYER_LINES[@]}"; do
  start="${LAYER_LINES[$i]}"
  if [ "$i" -lt "$(( ${#LAYER_LINES[@]} - 1 ))" ]; then
    end=$(( ${LAYER_LINES[$((i+1))]} - 1 ))
  else
    end="$TOTAL_LINES"
  fi

  heading=$(sed -n "${start}p" "$DOC")
  echo "================================================================"
  echo "${heading}    [lines ${start}-${end}]"
  echo "================================================================"

  echo "--- ### sub-headings under this layer ---"
  sed -n "${start},${end}p" "$DOC" | grep -nE '^### ' | awk -v offset="$((start-1))" -F: '{printf "  line %d: %s\n", offset+$1, substr($0, index($0,$2))}'
  echo

  echo "--- echo \"…\" lines inside this layer ---"
  sed -n "${start},${end}p" "$DOC" | grep -nE 'echo "' | awk -v offset="$((start-1))" -F: '{printf "  line %d: %s\n", offset+$1, substr($0, index($0,$2))}'
  echo
done

echo "================================================================"
echo "Agent: read the lines above. Judge each layer:"
echo "  - Does the layer have all four sub-headings (Setup, Run, Evidence to collect, Agent judgment)?"
echo "  - Among the echo lines, are any of the form: cmd && echo \"…\" || echo \"…\"  ?"
echo "    Those are verdict-emit shapes (forbidden by the principle)."
echo "  - Are any echo lines just labels (\"--- X ---\", \"header: \$VAR\") ? Those are fine."
echo "The viewer does not classify. You do."
echo "================================================================"
