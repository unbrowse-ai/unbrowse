#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../../.." && pwd)"
SKILL_DIR="$ROOT/.agents/skills/unbrowse-bench-corpus-builder"

test -f "$SKILL_DIR/SKILL.md"
test -x "$SKILL_DIR/scripts/validate.sh"
test -f "$SKILL_DIR/references/plan.md"
test -f "$SKILL_DIR/references/taxonomy.md"
test -f "$SKILL_DIR/references/judging-contract.md"
test -f "$SKILL_DIR/assets/probe-template.txt"

if grep -R $'\xe2\x80\x94' "$SKILL_DIR/SKILL.md" "$SKILL_DIR/references" "$SKILL_DIR/assets"; then
  echo "FAIL: em dash found" >&2
  exit 1
fi

if grep -Ev '^\s*(#|$)' "$ROOT/harness/probes/corpus-gate.txt" | grep -E '\b(INDEX_|RETRIEVE_|PASS|FAIL)\b'; then
  echo "FAIL: corpus contains verdict language" >&2
  exit 1
fi

bun "$ROOT/scripts/bench-corpus.ts" validate --corpus "$ROOT/harness/probes/corpus-gate.txt" >/tmp/unbrowse-bench-corpus-validation.json
cat /tmp/unbrowse-bench-corpus-validation.json
