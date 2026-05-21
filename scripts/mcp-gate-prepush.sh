#!/usr/bin/env bash
# mcp-gate-prepush.sh; .husky/pre-push gate for the MCP surface.
#
# Source of truth: the meta-harness scaffold
#   .claude/use-unbrowse-mcp-against-the-1000-probe-bench-co/ledgers/iterations.jsonl
#
# Substrate-faithful: the harness COLLECTS evidence per iterate, the agent
# JUDGES in-thread, this hook just SURFACES the most recent row + the
# capability-affecting commit timestamp it must post-date. No stamp.mcp.json,
# no separate verdict pipeline; one harness drives both bench, release, and
# pre-push.
#
# Mirrors scripts/bench-gate-prerelease.sh's deterministic ledger check,
# but: (a) fires only when the push targets `main`, (b) keyed to the
# pushed sha + the push delta (not release HEAD). A git hook runs
# headless and cannot judge; it can only enforce that the agent-judged
# harness row exists and is fresh.
#
# pre-push contract: $1=remote name, $2=remote url, ref lines on stdin:
#   <local ref> <local sha> <remote ref> <remote sha>
#
# Algorithm:
#   1. Not pushing main             -> ALLOW (no signal to enforce)
#   2. No gate-affecting paths in the push delta -> ALLOW (nothing to gate)
#   3. Ledger absent / unreadable   -> BLOCK with iterate instructions
#   4. Tail row status not in PASS_SET -> BLOCK (re-iterate)
#   5. Tail row exit_code != 0      -> BLOCK (re-iterate)
#   6. Capability code newer than row (between row ts and pushed sha) -> BLOCK
#   7. Otherwise                    -> ALLOW
#
# Capability-affecting paths (regression in any of these requires re-judging):
#   src/                                          CLI + resolve + execute + capture
#   packages/sdk/                                 public SDK surface
#   harness/probes/corpus-gate.txt                the corpus itself
#   harness/probes/GATE_JUDGE.md                  the rubric
#   harness/probes/bench-gate-baseline.json       thresholds + frozen verdicts
#
# Override (NEVER routine, never silently):
#   MCP_GATE_BYPASS=1   acknowledge you're pushing un-gated; logs loudly,
#                       requires a CHANGELOG note.
#
# Exit 0 = allow push. Exit 1 = block.
set -euo pipefail

HARNESS_DIR=".claude/use-unbrowse-mcp-against-the-1000-probe-bench-co"
LEDGER="$HARNESS_DIR/ledgers/iterations.jsonl"
PATHS=(
  "src"
  "packages/sdk"
  "harness/probes/corpus-gate.txt"
  "harness/probes/GATE_JUDGE.md"
  "harness/probes/bench-gate-baseline.json"
)
# Statuses produced by the harness's verify.sh that the gate accepts as PASS.
# "verified" is the canonical OK; "shipped" is wave-shipped (already merged);
# "converged" is end-of-loop.
PASS_SET='^(verified|shipped|converged)$'
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

iterate_instructions() {
  cat >&2 <<'EOF'

The MCP gate has not judged this code. To unblock:

  1. Iterate the bench-mcp-safety meta-harness scaffold; the agent judges
     the wave's verdict per the inherited substrate principle:

       bash ~/.claude/skills/meta-harness/scripts/harness iterate \
         use-unbrowse-mcp-against-the-1000-probe-bench-co

  2. That appends a row to:
       .claude/use-unbrowse-mcp-against-the-1000-probe-bench-co/ledgers/iterations.jsonl
     When the tail row's status is one of (verified|shipped|converged)
     AND its ts post-dates every capability-affecting commit in the push
     delta, this hook accepts it and the push proceeds.
  3. Commit any ledger change and retry the push.

To bypass deliberately (NOT routine), set MCP_GATE_BYPASS=1 and explain
in CHANGELOG.
EOF
}

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

# Gate-affecting code is reaching main. Require a fresh harness row.

if [[ ! -f "$LEDGER" ]]; then
  red "[mcp-gate-prepush] BLOCKED; no harness ledger at $LEDGER"
  iterate_instructions
  exit 1
fi

if ! command -v python3 >/dev/null 2>&1; then
  red "[mcp-gate-prepush] BLOCKED; python3 required to parse ledger row"
  exit 1
fi

# Read the tail row. python3 is already a hard prereq across this repo.
ROW_JSON=$(tail -n 1 "$LEDGER" 2>/dev/null || true)
if [[ -z "$ROW_JSON" ]]; then
  red "[mcp-gate-prepush] BLOCKED; ledger exists but is empty: $LEDGER"
  iterate_instructions
  exit 1
fi

if ! ROW_FIELDS=$(printf '%s' "$ROW_JSON" | python3 -c '
import json, sys
try:
    row = json.loads(sys.stdin.read())
except Exception as e:
    print(f"_PARSE_ERROR_:{e}", end="")
    sys.exit(0)
ts = row.get("ts", "")
status = row.get("status", "")
exit_code = row.get("exit_code", "?")
iter_n = row.get("iter", "?")
note = (row.get("note") or "")[:240]
print(f"{ts}|{status}|{exit_code}|{iter_n}|{note}", end="")
' 2>&1); then
  red "[mcp-gate-prepush] BLOCKED; tail row unreadable"
  red "  $ROW_FIELDS"
  iterate_instructions
  exit 1
fi

if [[ "$ROW_FIELDS" == _PARSE_ERROR_:* ]]; then
  red "[mcp-gate-prepush] BLOCKED; tail row not valid JSON: ${ROW_FIELDS#_PARSE_ERROR_:}"
  iterate_instructions
  exit 1
fi

IFS='|' read -r ROW_TS ROW_STATUS ROW_EXIT ROW_ITER ROW_NOTE <<< "$ROW_FIELDS"

# Status must be in PASS_SET AND row exit_code must be 0
if ! [[ "$ROW_STATUS" =~ $PASS_SET ]]; then
  red "[mcp-gate-prepush] BLOCKED; latest harness row status is '$ROW_STATUS' (need: verified|shipped|converged)"
  red "  iter=$ROW_ITER  ts=$ROW_TS  exit=$ROW_EXIT"
  [[ -n "$ROW_NOTE" ]] && red "  note: $ROW_NOTE"
  iterate_instructions
  exit 1
fi

if [[ "$ROW_EXIT" != "0" ]]; then
  red "[mcp-gate-prepush] BLOCKED; latest harness row exit_code=$ROW_EXIT (need 0)"
  red "  iter=$ROW_ITER  status=$ROW_STATUS  ts=$ROW_TS"
  [[ -n "$ROW_NOTE" ]] && red "  note: $ROW_NOTE"
  iterate_instructions
  exit 1
fi

# Capability-affecting commit timestamp for the pushed-sha range.
# Find the newest commit in (base..pushed_sha] that touches any declared
# capability path. The row must post-date this.
LAST_CAP_TS=""
LAST_CAP_SHA=""
if [[ -n "$base" ]]; then
  LAST_CAP_TS="$(git log -1 --format=%cI "$base..$pushed_sha" -- "${PATHS[@]}" 2>/dev/null || true)"
  LAST_CAP_SHA="$(git log -1 --format=%H "$base..$pushed_sha" -- "${PATHS[@]}" 2>/dev/null || true)"
fi
# Fallback: newest cap-touching commit reachable from pushed_sha (covers
# the unknown-base path where we conservatively gate the whole history).
if [[ -z "$LAST_CAP_TS" ]]; then
  LAST_CAP_TS="$(git log -1 --format=%cI "$pushed_sha" -- "${PATHS[@]}" 2>/dev/null || true)"
  LAST_CAP_SHA="$(git log -1 --format=%H "$pushed_sha" -- "${PATHS[@]}" 2>/dev/null || true)"
fi
if [[ -z "$LAST_CAP_TS" ]]; then
  # No cap-path history at all (e.g. shallow clone). Trust the harness row.
  LAST_CAP_TS="1970-01-01T00:00:00+00:00"
fi

# Normalize both timestamps to UTC before comparing. git log -%cI emits
# the committer's local offset (e.g. +08:00 SGT); python-written rows
# typically emit Z (+00:00). Lexicographic compare only works with a
# shared offset, so convert both to UTC ISO-8601 first.
ROW_TS_UTC=$(python3 -c "from datetime import datetime,timezone; print(datetime.fromisoformat('$ROW_TS'.replace('Z','+00:00')).astimezone(timezone.utc).isoformat())" 2>/dev/null || echo "$ROW_TS")
CAP_TS_UTC=$(python3 -c "from datetime import datetime,timezone; print(datetime.fromisoformat('$LAST_CAP_TS'.replace('Z','+00:00')).astimezone(timezone.utc).isoformat())" 2>/dev/null || echo "$LAST_CAP_TS")

if [[ "$ROW_TS_UTC" < "$CAP_TS_UTC" ]]; then
  red "[mcp-gate-prepush] BLOCKED; capability code has changed since the last harness wave"
  red "  last capability commit: $LAST_CAP_SHA at $LAST_CAP_TS"
  red "  latest harness row:     iter=$ROW_ITER status=$ROW_STATUS at $ROW_TS"
  red ""
  red "  Capability-affecting files in this push:"
  while IFS= read -r f; do red "    $f"; done <<< "$CHANGED"
  iterate_instructions
  exit 1
fi

grn "[mcp-gate-prepush] PASS; harness ledger row post-dates capability code in push delta"
grn "  source:  $LEDGER"
grn "  row:     iter=$ROW_ITER  status=$ROW_STATUS  exit=$ROW_EXIT  ts=$ROW_TS"
grn "  capcode: $LAST_CAP_SHA at $LAST_CAP_TS"
[[ -n "$ROW_NOTE" ]] && grn "  note:    $ROW_NOTE"
exit 0
