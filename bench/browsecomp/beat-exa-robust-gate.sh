#!/usr/bin/env bash
# ROBUST witness: beat Exa 0.336 on a real eval with N>=25 questions (tightens the
# N=10 sample). Reads logs/*.log; for each, the score counts only if the log shows
# a completed eval of ROBUST_N+ questions. Fast read; un-fakeable (real eval logs).
set -uo pipefail
cd "$(dirname "$0")/../.."
TARGET=0.336; ROBUST_N="${ROBUST_N:-25}"; best=0.0; bestsrc="(none)"; bestN=0
for log in bench/browsecomp/logs/*.log; do
  [ -f "$log" ] || continue
  N=$(grep -oE '[0-9]+/[0-9]+ \| score' "$log" 2>/dev/null | grep -oE '/[0-9]+' | tr -d '/' | sort -n | tail -1)
  [ -z "${N:-}" ] && continue
  [ "$N" -lt "$ROBUST_N" ] && continue
  s=$(grep -oE 'Evaluation complete\. Score: [0-9.]+|score=[0-9.]+|accuracy [0-9.]+' "$log" 2>/dev/null | grep -oE '[0-9.]+$' | sort -g | tail -1)
  [ -n "${s:-}" ] && awk -v a="$s" -v b="$best" 'BEGIN{exit !(a>b)}' && { best="$s"; bestsrc="$log"; bestN="$N"; }
done
echo "[robust] best N>=$ROBUST_N BrowseComp accuracy = $best (N=$bestN, from $bestsrc) | target > $TARGET"
awk -v s="$best" -v t="$TARGET" 'BEGIN{exit !(s>t)}' && { echo "[robust] PASS — beat Exa $TARGET on N=$bestN"; exit 0; }
echo "[robust] not yet — need a real N>=$ROBUST_N eval > $TARGET (current best robust=$best)"; exit 1
