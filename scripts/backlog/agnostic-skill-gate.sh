#!/usr/bin/env bash
# agnostic-skill-gate.sh — witness for agnostic-skill: the unbrowse skill is
# framework-agnostic (drops into any agent framework via pointers), not
# claude-specific. Checks the universal SKILL.md that `npx skills add` installs.
set -uo pipefail
REPO="$(cd "$(dirname "$0")/../.." && pwd)"; cd "$REPO"
S=SKILL.md
[ -f "$S" ] || { echo "FAIL: root SKILL.md missing"; exit 1; }
grep -qE '^name:[[:space:]]*unbrowse' "$S" && grep -qE '^description:' "$S" \
  || { echo "FAIL: not a valid universal agentskills.io SKILL.md (name+description)"; exit 1; }
# host-agnostic runtime pointer (npx unbrowse), not a claude-only path
grep -qE 'npx .*unbrowse' "$S" || { echo "FAIL: no host-agnostic runtime pointer (npx unbrowse)"; exit 1; }
# names multiple distinct MCP hosts → not single-framework
hosts=$(grep -oiE 'cursor|codex|windsurf|claude desktop|gemini|cline' "$S" | sort -u | wc -l | tr -d ' ')
[ "${hosts:-0}" -ge 3 ] || { echo "FAIL: names <3 distinct non-trivial hosts ($hosts) — looks framework-specific"; exit 1; }
# no claude-only hardcoding
if grep -qiE 'requires claude|claude.?code only|only works (in|with) claude|\.claude/[^ ]*only' "$S"; then
  echo "FAIL: claude-only hardcoding in SKILL.md"; exit 1
fi
echo "ok: SKILL.md is a universal agentskills.io skill — host-agnostic runtime (npx unbrowse), $hosts MCP hosts, no claude-only hardcoding (installs to any framework via npx skills add)"
