#!/usr/bin/env bash
# mcp-gate-prepush.sh; .husky/pre-push gate for the MCP surface.
#
# Mirrors scripts/bench-gate-prerelease.sh's deterministic stamp check,
# but: (a) fires only when the push targets `main`, (b) keyed to the
# pushed sha + the push delta (not release HEAD), (c) checks the DISTINCT
# .bench-gate/stamp.mcp.json (the MCP-surface stamp produced by the
# /unbrowse-mcp-gate skill; the agent judges, the skill stamps, this
# hook only verifies). A git hook runs headless and cannot judge; it can
# only enforce that the agent-judged MCP stamp exists and is fresh.
#
# pre-push contract: $1=remote name, $2=remote url, ref lines on stdin:
#   <local ref> <local sha> <remote ref> <remote sha>
#
# Exit 0 = allow push. Exit 1 = block (gate-affecting code reaching main
# without a fresh agent-judged MCP stamp).
set -euo pipefail

STAMP=".bench-gate/stamp.mcp.json"
PATHS=(
  "src"
  "packages/sdk"
  "harness/probes/corpus-gate.txt"
  "harness/probes/GATE_JUDGE.md"
  "harness/probes/bench-gate-baseline.json"
)
ZERO="0000000000000000000000000000000000000000"

red() { printf '\033[31m%s\033[0m\n' "$*" >&2; }
yel() { printf '\033[33m%s\033[0m\n' "$*" >&2; }
grn() { printf '\033[32m%s\033[0m\n' "$*" >&2; }

if [[ "${MCP_GATE_BYPASS:-0}" == "1" ]]; then
  yel "[mcp-gate-prepush] BYPASSED via MCP_GATE_BYPASS=1"
  yel "[mcp-gate-prepush] You are pushing capability code to main that the"
  yel "[mcp-gate-prepush] MCP-surface gate has NOT judged. Note it in CHANGELOG."
  exit 0
fi

# Find the main ref among the pushed refs (stdin). Capture its pushed
# local sha and the sha currently on the remote (diff base).
pushed_sha=""
remote_sha=""
while read -r local_ref local_sha remote_ref _rsha; do
  case "$remote_ref" in
    refs/heads/main)
      pushed_sha="$local_sha"
      remote_sha="$_rsha"
      ;;
  esac
done || true

# Not pushing main -> not this gate's concern.
if [[ -z "$pushed_sha" ]]; then
  exit 0
fi
# Branch deletion (local sha all-zero) -> nothing to gate.
if [[ "$pushed_sha" == "$ZERO" || -z "$pushed_sha" ]]; then
  exit 0
fi

# Diff base: the sha currently on remote/main if known, else origin/main,
# else the merge-base with origin/main. We only gate when a
# gate-affecting path actually changed in what is being pushed.
base=""
if [[ -n "$remote_sha" && "$remote_sha" != "$ZERO" ]] && git cat-file -e "$remote_sha^{commit}" 2>/dev/null; then
  base="$remote_sha"
elif git rev-parse --verify -q origin/main >/dev/null 2>&1; then
  base="$(git merge-base origin/main "$pushed_sha" 2>/dev/null || git rev-parse origin/main)"
fi

if [[ -n "$base" ]]; then
  CHANGED="$(git diff --name-only "$base" "$pushed_sha" -- "${PATHS[@]}" 2>/dev/null || true)"
  if [[ -z "$CHANGED" ]]; then
    grn "[mcp-gate-prepush] PASS; no gate-affecting paths changed in this push to main"
    exit 0
  fi
fi

# Gate-affecting code is reaching main (or base unknown -> be strict).
if [[ ! -f "$STAMP" ]]; then
  red "[mcp-gate-prepush] BLOCKED; pushing gate-affecting code to main with no MCP-surface stamp ($STAMP)"
  cat >&2 <<'EOF'

The MCP gate has not judged this code. To unblock:

  1. Run the /unbrowse-mcp-gate skill (in-thread MCP index/publish/execute
     dogfood over the 58-probe corpus, agent-judged against GATE_JUDGE.md).
  2. It writes .bench-gate/stamp.mcp.json on PASS.
  3. git add .bench-gate/stamp.mcp.json && git commit -m "chore: mcp-gate stamp"
  4. Retry the push.

To bypass deliberately (NOT routine), set MCP_GATE_BYPASS=1 and explain
in CHANGELOG.
EOF
  exit 1
fi

if ! command -v jq >/dev/null 2>&1; then
  red "[mcp-gate-prepush] BLOCKED; jq required to read $STAMP"
  exit 1
fi

GATE_PASSED="$(jq -r '.gate_passed // false' "$STAMP")"
STAMP_SHA="$(jq -r '.commit_sha // ""' "$STAMP")"
STAMP_RUN="$(jq -r '.run_id // "?"' "$STAMP")"

if [[ "$GATE_PASSED" != "true" ]]; then
  red "[mcp-gate-prepush] BLOCKED; $STAMP exists but gate_passed=$GATE_PASSED. Re-run /unbrowse-mcp-gate."
  exit 1
fi
if [[ -z "$STAMP_SHA" ]]; then
  red "[mcp-gate-prepush] BLOCKED; $STAMP has no commit_sha. Re-run /unbrowse-mcp-gate from a clean checkout."
  exit 1
fi
if [[ "$STAMP_SHA" == "$pushed_sha" ]]; then
  grn "[mcp-gate-prepush] PASS; MCP stamp matches pushed HEAD ($pushed_sha) run_id=$STAMP_RUN"
  exit 0
fi
# Stamp older than the pushed sha: allow only if NO gate-affecting path
# changed between the stamp commit and the pushed sha.
CHANGED_SINCE="$(git diff --name-only "$STAMP_SHA" "$pushed_sha" -- "${PATHS[@]}" 2>/dev/null || true)"
if [[ -z "$CHANGED_SINCE" ]]; then
  grn "[mcp-gate-prepush] PASS; MCP stamp from $STAMP_SHA; no gate-affecting change since (run_id=$STAMP_RUN)"
  exit 0
fi
red "[mcp-gate-prepush] BLOCKED; gate-affecting paths changed since the MCP stamp commit $STAMP_SHA:"
while IFS= read -r f; do red "    $f"; done <<< "$CHANGED_SINCE"
red "  Re-run /unbrowse-mcp-gate and commit a fresh .bench-gate/stamp.mcp.json before pushing to main."
exit 1
