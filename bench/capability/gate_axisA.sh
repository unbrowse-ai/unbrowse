#!/usr/bin/env bash
# gate_axisA.sh — Axis A tier-coverage witness. The hardest-scrape (H) AND automation (A)
# tiers must exceed 0.67 coverage (i.e. all 3 covered, up from the 2/3 baseline) — surfacing
# the SPA/anti-bot XHR endpoints that retrieval missed. Runs the live multi-tier corpus via
# `unbrowse explain` (UNBROWSE_BIN) and reads the official per-tier coverage from axis_a_corpus.
set -uo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$HERE/../.."
out="$(timeout 500 python3 -c "
import importlib.util
s=importlib.util.spec_from_file_location('la','bench/capability/live_axes.py')
la=importlib.util.module_from_spec(s); s.loader.exec_module(la)
la.axis_a_corpus('bench/capability/corpus/A_live.jsonl','gate-axisA')
" 2>&1)"
echo "$out" | grep -E '\[A multi-tier\]|per_tier' | tail -2
echo "$out" | python3 -c "
import sys, re, ast
raw = sys.stdin.read()
m = re.search(r'per_tier=(\{.*\})', raw)
if not m:
    print('  RED — no per_tier output (driver error?)'); sys.exit(1)
pt = ast.literal_eval(m.group(1))
h = pt.get('H', {}).get('coverage_rate', 0.0)
a = pt.get('A', {}).get('coverage_rate', 0.0)
ok = h > 0.67 and a > 0.67
print(f'  H coverage={h}  A coverage={a}  (target > 0.67 each) → {\"GREEN\" if ok else \"RED\"}')
sys.exit(0 if ok else 1)
"
