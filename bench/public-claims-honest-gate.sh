#!/usr/bin/env bash
# public-claims-honest-gate.sh — the inflated/mis-framed codebench claim is corrected in EVERY
# public-facing surface (deployed docs, frontend, whitepaper, BENCHMARKS), not just a dev paper.
# Exit 0 iff no public surface still states the degraded "25%" code-correctness baseline.
set -uo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/.."
PUB="docs/benchmarks.md frontend/src/app/docs/benchmarks/page.tsx paper/crypto-was-all-you-needed.md bench/BENCHMARKS.md bench/PROGRESS.md"
bad=0
for f in $PUB; do
  [ -f "$f" ] || continue
  # the inflated code-correctness baseline: "25%" adjacent to code-correctness / 100%
  if grep -nE '25%.{0,30}(100%|code)|code.correct.{0,20}25%|"25%".{0,40}code-correctness' "$f" >/dev/null 2>&1; then
    echo "[public] STILL INFLATED: $f"; grep -nE '25%' "$f" | head -2; bad=1
  else
    echo "[public] ok: $f — no degraded 25% code-correctness baseline"
  fi
done
[ "$bad" -eq 0 ] && { echo "[public] PASS — every public surface carries the honest code-correctness baseline"; exit 0; } || { echo "[public] FAIL — a public surface still states the inflated 25%"; exit 1; }
