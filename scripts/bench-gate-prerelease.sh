#!/usr/bin/env bash
# bench-gate-prerelease.sh — release-it before:init hook.
#
# Source of truth: the meta-harness scaffold
#   .claude/use-unbrowse-mcp-against-the-1000-probe-bench-co/ledgers/iterations.jsonl
#
# Substrate-faithful: the harness COLLECTS evidence per iterate, the agent
# JUDGES in-thread, this gate just SURFACES the most recent row + the
# capability-affecting commit timestamp it must post-date. No stamp.json,
# no separate verdict pipeline; one harness drives both bench and release.
#
# Algorithm:
#   1. Ledger absent              -> FAIL with iterate instructions
#   2. Tail row malformed         -> FAIL (read the file by hand)
#   3. Tail row status in PASS_SET AND ts >= last_capability_commit -> PASS
#   4. Tail row exit_code != 0    -> FAIL (re-iterate)
#   5. Capability code newer than row -> FAIL (re-iterate)
#
# Capability-affecting paths (regression in any of these requires re-judging):
#   src/                                          CLI + resolve + execute + capture
#   packages/sdk/                                 public SDK surface
#   harness/probes/corpus-gate.txt                the corpus itself
#   harness/probes/GATE_JUDGE.md                  the rubric
#   harness/probes/bench-gate-baseline.json       thresholds + frozen verdicts
#
# Override (NEVER in CI / never silently):
#   BENCH_GATE_BYPASS=1   acknowledge you're shipping un-gated; logs loudly.

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
# "converged" is end-of-loop. "verified-with-harness-bug" is a harness verify
# script bug, NOT a product bug, but we still require it to be post-dated by
# the last capability commit (handled below).
PASS_SET='^(verified|shipped|converged)$'

red() { printf '\033[31m%s\033[0m\n' "$*" >&2; }
yel() { printf '\033[33m%s\033[0m\n' "$*" >&2; }
grn() { printf '\033[32m%s\033[0m\n' "$*" >&2; }

if [[ "${BENCH_GATE_BYPASS:-0}" == "1" ]]; then
  yel "[bench-gate-prerelease] BYPASSED via BENCH_GATE_BYPASS=1"
  yel "[bench-gate-prerelease] You are shipping a release that has NOT been agent-gated."
  yel "[bench-gate-prerelease] Capability regressions will not be detected. Note this in CHANGELOG."
  exit 0
fi

iterate_instructions() {
  cat >&2 <<'EOF'
This release is blocked because no fresh agent-judged harness PASS exists
for the current code state.

To produce one: iterate the bench-mcp-safety meta-harness scaffold, then
let it judge the wave in-thread per references/SUBSTRATE-PRINCIPLE.md:

  bash ~/.claude/skills/meta-harness/scripts/harness iterate \
    use-unbrowse-mcp-against-the-1000-probe-bench-co

That appends one row to:
  .claude/use-unbrowse-mcp-against-the-1000-probe-bench-co/ledgers/iterations.jsonl

The agent judges the wave's verdict per the inherited substrate principle
(no script verdicts). When the tail row's status is one of
(verified | shipped | converged) AND its ts post-dates every capability-
affecting commit, this gate accepts it and the release proceeds.

To bypass deliberately (NOT in CI), set BENCH_GATE_BYPASS=1 and explain
in CHANGELOG.
EOF
}

if [[ ! -f "$LEDGER" ]]; then
  red "[bench-gate-prerelease] FAIL — no harness ledger at $LEDGER"
  iterate_instructions
  exit 1
fi

# Read the tail row. python3 is already a hard prereq across this repo.
ROW_JSON=$(tail -n 1 "$LEDGER" 2>/dev/null || true)
if [[ -z "$ROW_JSON" ]]; then
  red "[bench-gate-prerelease] FAIL — ledger exists but is empty: $LEDGER"
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
  red "[bench-gate-prerelease] FAIL — tail row unreadable"
  red "  $ROW_FIELDS"
  iterate_instructions
  exit 1
fi

if [[ "$ROW_FIELDS" == _PARSE_ERROR_:* ]]; then
  red "[bench-gate-prerelease] FAIL — tail row not valid JSON: ${ROW_FIELDS#_PARSE_ERROR_:}"
  iterate_instructions
  exit 1
fi

IFS='|' read -r ROW_TS ROW_STATUS ROW_EXIT ROW_ITER ROW_NOTE <<< "$ROW_FIELDS"

# Capability-affecting commit timestamp (ISO-8601 UTC of newest commit
# touching any declared capability path; missing path => skipped silently).
LAST_CAP_TS=$(git log -1 --format=%cI -- "${PATHS[@]}" 2>/dev/null || true)
LAST_CAP_SHA=$(git log -1 --format=%H -- "${PATHS[@]}" 2>/dev/null || true)

if [[ -z "$LAST_CAP_TS" ]]; then
  # No capability-path history (fresh repo / shallow clone) — no gate signal
  # to apply. Trust the harness row alone.
  LAST_CAP_TS="1970-01-01T00:00:00+00:00"
fi

# Status must be in PASS_SET AND row exit_code must be 0
if ! [[ "$ROW_STATUS" =~ $PASS_SET ]]; then
  red "[bench-gate-prerelease] FAIL — latest harness row status is '$ROW_STATUS' (need: verified|shipped|converged)"
  red "  iter=$ROW_ITER  ts=$ROW_TS  exit=$ROW_EXIT"
  [[ -n "$ROW_NOTE" ]] && red "  note: $ROW_NOTE"
  iterate_instructions
  exit 1
fi

if [[ "$ROW_EXIT" != "0" ]]; then
  red "[bench-gate-prerelease] FAIL — latest harness row exit_code=$ROW_EXIT (need 0)"
  red "  iter=$ROW_ITER  status=$ROW_STATUS  ts=$ROW_TS"
  [[ -n "$ROW_NOTE" ]] && red "  note: $ROW_NOTE"
  iterate_instructions
  exit 1
fi

# Lexicographic ISO-8601 comparison: row must be at-or-after last capability commit.
if [[ "$ROW_TS" < "$LAST_CAP_TS" ]]; then
  red "[bench-gate-prerelease] FAIL — capability code has changed since the last harness wave"
  red "  last capability commit: $LAST_CAP_SHA at $LAST_CAP_TS"
  red "  latest harness row:     iter=$ROW_ITER status=$ROW_STATUS at $ROW_TS"
  red ""
  red "  Capability-affecting files changed since the harness ran:"
  git log "${LAST_CAP_SHA}^..HEAD" --name-only --pretty=format: -- "${PATHS[@]}" 2>/dev/null | sort -u | sed '/^$/d' | while IFS= read -r f; do
    red "    $f"
  done || true
  iterate_instructions
  exit 1
fi

# Uncommitted changes to capability paths invalidate the row.
UNCOMMITTED=$(git status --porcelain -- "${PATHS[@]}" 2>/dev/null | awk '{print $2}' || true)
if [[ -n "$UNCOMMITTED" ]]; then
  red "[bench-gate-prerelease] FAIL — uncommitted changes to capability paths invalidate the harness row:"
  while IFS= read -r f; do red "    $f"; done <<< "$UNCOMMITTED"
  red "  Commit them and re-iterate the harness, or stash."
  exit 1
fi

grn "[bench-gate-prerelease] PASS — harness ledger row post-dates capability code"
grn "  source:  $LEDGER"
grn "  row:     iter=$ROW_ITER  status=$ROW_STATUS  exit=$ROW_EXIT  ts=$ROW_TS"
grn "  capcode: $LAST_CAP_SHA at $LAST_CAP_TS"
[[ -n "$ROW_NOTE" ]] && grn "  note:    $ROW_NOTE"
exit 0
