#!/usr/bin/env bash
# bench-gate-prerelease.sh — release-it before:init hook.
#
# Refuses to start a release unless a fresh agent-judged bench-gate PASS
# exists for the current state of capability-affecting code paths.
#
# The agent in-thread is the judge (see docs/release-gate-bench-plan.md),
# so this hook cannot run the gate itself. It checks for the stamp file
# the agent commits after a successful run:
#
#   .bench-gate/stamp.json   { commit_sha, gate_passed, run_id, ... }
#
# Algorithm:
#   1. Stamp absent           → FAIL with instructions
#   2. Stamp.gate_passed!=true → FAIL
#   3. Stamp commit == HEAD   → PASS
#   4. Stamp commit older AND no capability-affecting changes since stamp
#      AND no uncommitted capability-affecting changes → PASS
#   5. Otherwise              → FAIL with the file list
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

STAMP=".bench-gate/stamp.json"
PATHS=(
  "src"
  "packages/sdk"
  "harness/probes/corpus-gate.txt"
  "harness/probes/GATE_JUDGE.md"
  "harness/probes/bench-gate-baseline.json"
)

red() { printf '\033[31m%s\033[0m\n' "$*" >&2; }
yel() { printf '\033[33m%s\033[0m\n' "$*" >&2; }
grn() { printf '\033[32m%s\033[0m\n' "$*" >&2; }

if [[ "${BENCH_GATE_BYPASS:-0}" == "1" ]]; then
  yel "[bench-gate-prerelease] BYPASSED via BENCH_GATE_BYPASS=1"
  yel "[bench-gate-prerelease] You are shipping a release that has NOT been agent-gated."
  yel "[bench-gate-prerelease] Capability regressions will not be detected. Note this in CHANGELOG."
  exit 0
fi

if [[ ! -f "$STAMP" ]]; then
  red "[bench-gate-prerelease] FAIL — no bench-gate stamp at $STAMP"
  cat >&2 <<'EOF'

This release is blocked because no agent-judged bench-gate PASS exists
for the current code state. To unblock:

  1. bun run bench:gate:full
  2. (agent reads .bench-gate/<run-id>/judge.bundle.md and writes verdict.json)
  3. bun run bench:gate:validate -- --artifacts .bench-gate/<run-id>
  4. bun run bench:gate:compare -- --artifacts .bench-gate/<run-id> --stamp
  5. git add .bench-gate/stamp.json && git commit -m "chore: bench-gate stamp"
  6. retry the release

See docs/release-gate-bench-plan.md for the full protocol. To bypass
deliberately (NOT in CI), set BENCH_GATE_BYPASS=1 and explain in CHANGELOG.
EOF
  exit 1
fi

if ! command -v jq >/dev/null 2>&1; then
  red "[bench-gate-prerelease] FAIL — jq required to read $STAMP"
  exit 1
fi

GATE_PASSED=$(jq -r '.gate_passed // false' "$STAMP")
STAMP_SHA=$(jq -r '.commit_sha // ""' "$STAMP")
STAMP_RUN=$(jq -r '.run_id // "?"' "$STAMP")
STAMP_AT=$(jq -r '.stamped_at // "?"' "$STAMP")
STAMP_IDX=$(jq -r '.index_coverage // 0' "$STAMP")
STAMP_RET=$(jq -r '.retrieve_coverage // 0' "$STAMP")

if [[ "$GATE_PASSED" != "true" ]]; then
  red "[bench-gate-prerelease] FAIL — stamp exists but gate_passed=$GATE_PASSED"
  red "  Re-run the gate (step 1-5 above) before retrying release."
  exit 1
fi

CURRENT_SHA=$(git rev-parse HEAD)

# Uncommitted changes to gate-affecting paths invalidate any stamp.
# Check this BEFORE the stamp==HEAD shortcut so a dirty working tree never
# slips through.
UNCOMMITTED=$(git status --porcelain -- "${PATHS[@]}" 2>/dev/null | awk '{print $2}' || true)
if [[ -n "$UNCOMMITTED" ]]; then
  red "[bench-gate-prerelease] FAIL — uncommitted changes to gate-affecting paths:"
  while IFS= read -r f; do red "    $f"; done <<< "$UNCOMMITTED"
  red "  Either commit them and re-judge, or stash."
  exit 1
fi

if [[ "$STAMP_SHA" == "$CURRENT_SHA" ]]; then
  grn "[bench-gate-prerelease] PASS — stamp matches HEAD ($CURRENT_SHA)"
  grn "  run_id=$STAMP_RUN  stamped_at=$STAMP_AT  index=${STAMP_IDX}  retrieve=${STAMP_RET}"
  exit 0
fi

if [[ -z "$STAMP_SHA" ]]; then
  red "[bench-gate-prerelease] FAIL — stamp has no commit_sha"
  red "  Stamp was written outside a git checkout. Re-run with a clean repo state."
  exit 1
fi

# Stamp is older than HEAD. Allow only if no gate-affecting path changed.
CHANGED=$(git diff --name-only "$STAMP_SHA" HEAD -- "${PATHS[@]}" 2>/dev/null || true)
if [[ -n "$CHANGED" ]]; then
  red "[bench-gate-prerelease] FAIL — gate-affecting paths changed since stamp commit $STAMP_SHA:"
  while IFS= read -r f; do red "    $f"; done <<< "$CHANGED"
  red "  Re-run the gate (step 1-5 above) before retrying release."
  exit 1
fi

grn "[bench-gate-prerelease] PASS — stamp from $STAMP_SHA; no gate-affecting changes since"
grn "  run_id=$STAMP_RUN  stamped_at=$STAMP_AT  index=${STAMP_IDX}  retrieve=${STAMP_RET}"
exit 0
