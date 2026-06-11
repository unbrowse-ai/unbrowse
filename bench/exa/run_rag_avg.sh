#!/usr/bin/env bash
# run_rag_avg.sh — run the real Exa RAG eval K times and print MEAN groundedness +
# per-run values, so improvements are measured above the ~1-query single-run noise.
set -uo pipefail
K="${K:-3}"; vals=()
for i in $(seq 1 "$K"); do
  OUT="/tmp/avg_${i}.json" bash "$(dirname "$0")/run_rag.sh" >/tmp/avg_v_$i 2>/dev/null || true
  v=$(cut -d' ' -f1 /tmp/avg_v_$i 2>/dev/null)
  vals+=("$v")
done
python3 -c "
v=[float(x) for x in '${vals[*]}'.split() if x]
import statistics as st
print(f'mean={st.mean(v):.4f} runs={v} n_runs={len(v)}')
"
