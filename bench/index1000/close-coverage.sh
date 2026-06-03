#!/usr/bin/env bash
# close-coverage — drive UNIQUE coverage of a corpus to 100% by repeatedly running the
# parallel indexer over only the still-uncovered set. The parallel check-then-write resume
# race leaves a shrinking residual each pass; looping over the recomputed remainder converges
# it to zero. Un-fakeable: "covered" = a real ledger row keyed on the site, deduped.
#
#   bash close-coverage.sh <corpus.txt> <ledger.jsonl> [parallel] [per_site_timeout] [max_rounds]
set -uo pipefail
REPO="$(cd "$(dirname "$0")/../.." && pwd)"; cd "$REPO"
CORPUS="${1:?corpus}"; LEDGER="${2:?ledger}"
PAR="${3:-40}"; TMO="${4:-12}"; MAX="${5:-8}"
TMPDIR_LOCAL="$(dirname "$LEDGER")"
round=0
while [ "$round" -lt "$MAX" ]; do
  round=$((round+1))
  grep -oE '"site":"[^"]+"' "$LEDGER" 2>/dev/null | sed 's/"site":"//;s/"//' | sort -u > "$TMPDIR_LOCAL/.covered.txt"
  comm -23 <(grep -vE '^\s*#|^\s*$' "$CORPUS" | sort -u) "$TMPDIR_LOCAL/.covered.txt" > "$TMPDIR_LOCAL/.uncovered.txt"
  n=$(wc -l < "$TMPDIR_LOCAL/.uncovered.txt" | tr -d ' ')
  echo "[close] round $round: $n uncovered"
  [ "$n" -eq 0 ] && { echo "[close] DONE — full coverage"; break; }
  INDEX_OUT="$LEDGER" INDEX_PARALLEL="$PAR" PER_SITE_TIMEOUT="$TMO" \
    bash bench/index1000/run.sh "$TMPDIR_LOCAL/.uncovered.txt" "$PAR" >/dev/null 2>&1
done
grep -oE '"site":"[^"]+"' "$LEDGER" 2>/dev/null | sed 's/"site":"//;s/"//' | sort -u > "$TMPDIR_LOCAL/.covered.txt"
final=$(comm -12 <(grep -vE '^\s*#|^\s*$' "$CORPUS"|sort -u) "$TMPDIR_LOCAL/.covered.txt" | wc -l | tr -d ' ')
echo "[close] final unique coverage: $final / $(grep -vcE '^\s*#|^\s*$' "$CORPUS")"
