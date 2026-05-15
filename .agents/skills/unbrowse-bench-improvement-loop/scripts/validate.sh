#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../../.." && pwd)"
SKILL_DIR="$ROOT/.agents/skills/unbrowse-bench-improvement-loop"

test -f "$SKILL_DIR/SKILL.md"
test -x "$SKILL_DIR/scripts/validate.sh"
test -f "$SKILL_DIR/references/plan.md"
test -f "$SKILL_DIR/references/agent-judged-contract.md"
test -f "$SKILL_DIR/references/fix-loop.md"
test -f "$SKILL_DIR/assets/improvement-plan-template.md"
test -f "$ROOT/scripts/bench-improve-triage.ts"

if grep -R $'\xe2\x80\x94' "$SKILL_DIR/SKILL.md" "$SKILL_DIR/references" "$SKILL_DIR/assets"; then
  echo "FAIL: em dash found" >&2
  exit 1
fi

if grep -RE 'script.*(writes|creates).*verdict' "$SKILL_DIR/SKILL.md" "$SKILL_DIR/references" "$SKILL_DIR/assets"; then
  echo "FAIL: forbidden generated-verdict language found" >&2
  exit 1
fi

bun "$ROOT/scripts/bench-corpus.ts" validate --corpus "$ROOT/harness/probes/corpus-gate.txt" >/tmp/unbrowse-bench-loop-corpus.json
cat /tmp/unbrowse-bench-loop-corpus.json
