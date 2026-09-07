#!/usr/bin/env bash
# tsc-ratchet.sh — type-error regression ratchet (issue #843).
# The repo carries 1173 pre-existing tsc errors that MASK new type regressions. This gate
# pins that count as a baseline and fails ONLY when the count GROWS — so a newly-introduced
# type error can no longer hide in the noise. It does NOT require fixing the 1173 (a multi-day
# task); it stops the masking, which is the issue's actual concern. As errors get fixed, the
# "tighten" note tells you to lower the baseline (the ratchet only ever tightens).
#   CI uses the no-arg form (runs the real tsc).  `--dry <n>` prints the verdict for a
#   hypothetical count (witness helper only — never gates CI).
set -uo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"; cd "$ROOT"
base=$(cat .tsc-baseline 2>/dev/null || echo 0)
if [ "${1:-}" = "--dry" ]; then count="$2"; else
  count=$(npx tsc --noEmit -p tsconfig.json 2>&1 | grep -cE "error TS")
fi
echo "tsc errors: $count   baseline: $base"
if [ "$count" -gt "$base" ]; then
  echo "TSC-RATCHET RED — $((count - base)) NEW type error(s) above baseline (#843: a regression slipped past the mask)"; exit 1
fi
[ "$count" -lt "$base" ] && echo "note: $((base - count)) fewer than baseline — tighten .tsc-baseline to $count (ratchet only tightens)"
echo "TSC-RATCHET GREEN — no new type errors above baseline $base"; exit 0
