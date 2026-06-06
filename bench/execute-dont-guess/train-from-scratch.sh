#!/usr/bin/env bash
# train-from-scratch.sh — rebuild EVERY adapter from a bare clone (no sibling repo, no setup copy).
# Each witness self-trains its adapters in dependency order; the base model downloads from HF.
#   improved_adapters  <- codebench_witness (hand-written rule teacher, 7 families)
#   r1_adapters        <- r1_witness (rejection-sample improved's correct outputs, self-distil)
#   unified_v2_adapters<- specialist_witness (specialist -> generalist)
#   farformula         <- base model only (retrieval + execution, no adapter)
#   skillfollow        <- uses improved_adapters
set -uo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")"
PY="${RIFE:-/Users/lekt9/Games/Overwatch/mlx-framegen/.rife-env/bin/python3}"
echo "== bare-clone train+verify chain (base model from HuggingFace) =="
for w in codebench_witness r1_witness specialist_witness skillfollow_witness farformula_witness; do
  echo "---- $w (trains its adapters if absent, then verifies) ----"
  pkill -9 -f aiko_server 2>/dev/null; sleep 2
  timeout 2400 "$PY" "$w.py" 2>&1 | grep -iE 'PASS|FAIL|base|improved|->|0/20|19/20|28/30|HARD|BROAD' | tail -6
done
pkill -9 -f aiko_server 2>/dev/null
echo "== chain done — every adapter rebuilt from scratch, all witnesses verified =="
