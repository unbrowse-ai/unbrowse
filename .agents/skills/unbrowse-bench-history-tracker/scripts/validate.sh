#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../../.." && pwd)"
SKILL_DIR="$ROOT/.agents/skills/unbrowse-bench-history-tracker"

test -f "$SKILL_DIR/SKILL.md"
test -x "$SKILL_DIR/scripts/validate.sh"
test -f "$SKILL_DIR/references/plan.md"
test -f "$SKILL_DIR/references/contract.md"
test -f "$SKILL_DIR/references/release-notes-flow.md"
test -f "$SKILL_DIR/assets/run-row-template.json"
test -f "$ROOT/scripts/bench-history-record.ts"
test -f "$ROOT/scripts/bench-history-release-notes.ts"

# No em dashes (project ban)
if grep -R $'\xe2\x80\x94' "$SKILL_DIR/SKILL.md" "$SKILL_DIR/references" "$SKILL_DIR/assets"; then
  echo "FAIL: em dash found in skill content" >&2
  exit 1
fi

# Frontmatter has load-bearing output mode language
if ! grep -q "Default output is always" "$SKILL_DIR/SKILL.md"; then
  echo "FAIL: SKILL.md frontmatter description missing 'Default output is always' load-bearing clause" >&2
  exit 1
fi

# Recorder scripts parse cleanly (bun build is a syntax check without running main)
cd "$ROOT"
if ! bun build --target=bun scripts/bench-history-record.ts --outdir /tmp/bench-history-check >/dev/null 2>&1; then
  echo "FAIL: bench-history-record.ts does not parse" >&2
  bun build --target=bun scripts/bench-history-record.ts --outdir /tmp/bench-history-check 2>&1 | head -20 >&2
  exit 1
fi
if ! bun build --target=bun scripts/bench-history-release-notes.ts --outdir /tmp/bench-history-check >/dev/null 2>&1; then
  echo "FAIL: bench-history-release-notes.ts does not parse" >&2
  bun build --target=bun scripts/bench-history-release-notes.ts --outdir /tmp/bench-history-check 2>&1 | head -20 >&2
  exit 1
fi
rm -rf /tmp/bench-history-check

# Template JSON parses
if ! python3 -c "import json,sys; json.load(open('$SKILL_DIR/assets/run-row-template.json'))" 2>/dev/null; then
  echo "FAIL: run-row-template.json is not valid JSON" >&2
  exit 1
fi

# package.json declares the scripts
if ! grep -q '"bench:history:record"' "$ROOT/package.json"; then
  echo "FAIL: package.json missing bench:history:record script" >&2
  exit 1
fi
if ! grep -q '"bench:history:release-notes"' "$ROOT/package.json"; then
  echo "FAIL: package.json missing bench:history:release-notes script" >&2
  exit 1
fi

echo "ok"
