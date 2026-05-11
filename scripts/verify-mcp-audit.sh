#!/usr/bin/env bash
# Falsifiable signals for docs/mcp-vs-cli-ux-audit.md.
# Each assertion mirrors one row in the audit. When a gap closes, the verifier
# flips and the audit must be refreshed.

set -u
fail=0
check() {
  local label=$1; shift
  if "$@"; then printf "PASS  %s\n" "$label"
  else          printf "FAIL  %s\n" "$label"; fail=1; fi
}

mcp=src/mcp.ts
cli=src/cli.ts

# Precondition: both files exist. A missing file is not "audit stale" — it's setup error.
for f in "$mcp" "$cli"; do
  if [ ! -f "$f" ]; then
    echo "ERROR  required source file missing: $f"
    echo "       (this verifier asserts claims against the live tree; rerun from repo root)"
    exit 2
  fi
done

# Strip // and /* */ single-line comments before grepping for code-only signals.
code_only() { sed -E 's|//.*$||; s|/\*.*\*/||' "$1"; }

# listChanged:false inside a `<key>: { ... }` block (multi-line).
check_blockfalse() {
  local key=$1
  awk -v k="$key" '
    $0 ~ "^[[:space:]]*"k":[[:space:]]*\\{[[:space:]]*$" { inblock=1; next }
    inblock && /listChanged:[[:space:]]*false/ { found=1; exit }
    inblock && /^[[:space:]]*\},?[[:space:]]*$/ { inblock=0 }
    END { exit found?0:1 }
  ' "$mcp"
}

# Helpers to assert listChanged=true on a block (Phase 2 closed Gap 1a/1c)
check_blocktrue() {
  local key=$1
  awk -v k="$key" '
    $0 ~ "^[[:space:]]*"k":[[:space:]]*\\{[[:space:]]*$" { inblock=1; next }
    inblock && /listChanged:[[:space:]]*true/ { found=1; exit }
    inblock && /^[[:space:]]*\},?[[:space:]]*$/ { inblock=0 }
    END { exit found?0:1 }
  ' "$mcp"
}
check "Gap 1a (CLOSED Phase 2) — tools.listChanged is true"      check_blocktrue tools
check "Gap 1b — resources.listChanged is false (deliberate scope)" check_blockfalse resources
check "Gap 1c (CLOSED Phase 2) — prompts.listChanged is true"    check_blocktrue prompts

# Gap 1d closed: notifications/tools/list_changed is now dispatched (real, not comment-only)
check_real_list_changed() {
  code_only "$mcp" | grep -qE '"notifications/tools/list_changed"'
}
check "Gap 1d (CLOSED Phase 2) — list_changed notification dispatched" check_real_list_changed
check "Gap 2a — MCP injects _workflow_hints" \
  bash -c "grep -q '_workflow_hints' $mcp"
check "Gap 2b (CLOSED Phase 1) — MCP NOW emits a root-level next_action object" \
  bash -c "grep -E 'next_action:[[:space:]]*\{' $mcp >/dev/null"
check "Gap 2c — CLI emits a structured next_action object" \
  bash -c "grep -E 'next_action:[[:space:]]*\{' $cli >/dev/null"

check "Gap 3 (CLOSED Phase 3) — MCP NOW exposes workflow:* recipe names" \
  bash -c "grep -E '\"workflow:[a-z-]+\"' $mcp >/dev/null"

check "Parity — prompts/list handler present" \
  bash -c "grep -q 'ListPromptsRequestSchema\|prompts/list' $mcp"
check "Parity — resources/list handler present" \
  bash -c "grep -q 'ListResourcesRequestSchema\|resources/list' $mcp"

echo
if [ $fail -eq 0 ]; then
  echo "All audit claims hold against live source."
  exit 0
else
  echo "Audit is stale: at least one claim no longer matches src/. Refresh docs/mcp-vs-cli-ux-audit.md."
  exit 1
fi
