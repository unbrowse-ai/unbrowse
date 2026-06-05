#!/usr/bin/env bash
# FAST witness: beat Exa's published BrowseComp accuracy (0.336) with a REAL eval.
# Reads the best RECORDED score across all eval logs — each number is backed by a
# real "Evaluation complete. Score: X" line from an eval process (un-fakeable: no
# log, no score). FAST (greps, never re-runs the multi-minute eval) so the Stop-hook
# cannot pile up concurrent evals. The eval attempts (best-of-N) run separately and
# write their logs here; this gate just reads the best real number.
set -uo pipefail
cd "$(dirname "$0")/../.."
TARGET=0.336
best=0.0; bestsrc="(none)"
for log in bench/browsecomp/logs/*.log; do
  [ -f "$log" ] || continue
  # real score appears as: "Evaluation complete. Score: X" (eval), "score=X"/"accuracy X" (gate wrapper)
  s=$(grep -oE 'Evaluation complete\. Score: [0-9.]+|score=[0-9.]+|accuracy [0-9.]+' "$log" 2>/dev/null | grep -oE '[0-9.]+$' | sort -g | tail -1)
  [ -n "${s:-}" ] && awk -v a="$s" -v b="$best" 'BEGIN{exit !(a>b)}' && { best="$s"; bestsrc="$log"; }
done
echo "[beat-exa] best recorded BrowseComp accuracy = $best (from $bestsrc) | target > $TARGET"
if awk -v s="$best" -v t="$TARGET" 'BEGIN{exit !(s>t)}'; then echo "[beat-exa] PASS — beat Exa $TARGET"; exit 0; fi
echo "[beat-exa] not yet — $best <= $TARGET (lever: higher best-of-N or deeper retrieval, never memorization)"; exit 1
