#!/usr/bin/env bash
# master-plan-gate — the witness that internal/MASTER_PLAN.md is REAL, not fabricated:
#   1. it exists,
#   2. it is gitignored (internal — it never leaks to a public surface),
#   3. every repo artifact it references actually exists (no fabricated shipped claim),
#   4. it lays out the ordered phases (0..4) + the external-blocker structure.
# It does NOT judge the strategy's correctness — only that the plan is honest + private.
set -uo pipefail
cd "$(dirname "$0")/.."
PLAN="internal/MASTER_PLAN.md"
fail=0

[ -f "$PLAN" ] || { echo "[master-plan-gate] FAIL — $PLAN missing"; exit 1; }

echo "=== 1. internal / gitignored (no public leak) ==="
if git check-ignore "$PLAN" >/dev/null 2>&1; then
  echo "  ok — $PLAN is gitignored"
else
  echo "  FAIL — $PLAN is NOT gitignored (a master plan must stay internal)"; fail=1
fi

echo "=== 2. reflect: every referenced repo artifact exists (no fabrication) ==="
refs=$(grep -oE '(src|backend/src)/[A-Za-z0-9/_-]+\.ts|packages/py-[a-z-]+|scripts/[a-z-]+\.sh|bench/exa/[a-z-]+\.sh|paper/internal-apis\.tex|backend/tests/[A-Za-z0-9/_-]+\.ts' "$PLAN" | sort -u)
missing=0
for r in $refs; do
  if [ -e "$r" ]; then :; else echo "  MISSING: $r"; missing=$((missing+1)); fail=1; fi
done
[ "$missing" -eq 0 ] && echo "  ok — all $(echo "$refs" | wc -l | tr -d ' ') referenced artifacts exist"

echo "=== 3. structure: ordered phases 0..4 + external blockers ==="
for p in "Phase 0" "Phase 1" "Phase 2" "Phase 3" "Phase 4"; do
  grep -q "## $p" "$PLAN" || { echo "  MISSING section: $p"; fail=1; }
done
grep -qiE "blocker" "$PLAN" || { echo "  MISSING: external-blocker structure"; fail=1; }
[ "$fail" -eq 0 ] && echo "  ok — phases 0-4 present with blockers"

echo
if [ "$fail" -ne 0 ]; then echo "[master-plan-gate] FAIL — plan is incomplete, leaks, or references something unreal."; exit 1; fi
echo "[master-plan-gate] PASS — the master plan is real, internal, ordered, and references only what exists."
