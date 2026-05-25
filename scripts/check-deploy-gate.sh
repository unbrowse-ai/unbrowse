#!/usr/bin/env bash
#
# scripts/check-deploy-gate.sh
#
# Production-deploy gate. Refuses release until the substrate-declared
# deploy-gate contract is satisfied. The gate fires when:
#
#   1. Every DEFERRED-* contract from the monetization organs is satisfied
#      (STAGE-1-IMPLS, contract id c26e9c0d).
#   2. The bench is 100% across all 7 capability dimensions
#      (STAGE-2-BENCH-100, contract id 00a4571a).
#
# Root organ: 50c57083.
#
# This is the mechanical enforcement of Lewis's standing instruction:
# deploy ONLY once benchmark hits 100% across all dimensions and every
# named impl shipped. The gate is not a discipline rule, it is a
# precondition the release flow refuses to skip.
#
# Exit codes:
#   0 — gate satisfied, release may proceed
#   1 — gate unsatisfied, list of blockers printed to stderr
#   2 — gate metadata missing (contract substrate not present or root
#       contract id not declared in this environment)
#
# Bypass: set DEPLOY_GATE_BYPASS=1 with a documented reason in the
# release commit message. Bypass is logged to stderr; the CI workflow
# can choose to refuse it for protected branches.

set -euo pipefail

ROOT_CONTRACT_ID="50c57083"
CONTRACT_BIN="${HOME}/.claude/skills/contract/scripts/contract"

if [ "${DEPLOY_GATE_BYPASS:-0}" = "1" ]; then
  echo "[deploy-gate] DEPLOY_GATE_BYPASS=1 — bypassed (reason MUST be in release commit message)" >&2
  exit 0
fi

if [ ! -x "$CONTRACT_BIN" ]; then
  echo "[deploy-gate] FAIL — contract substrate missing at $CONTRACT_BIN" >&2
  echo "[deploy-gate] cannot verify gate — refuse to deploy" >&2
  exit 2
fi

# Read root contract status. Substrate prints a tree; we parse for the root row.
status_output=$("$CONTRACT_BIN" status "$ROOT_CONTRACT_ID" 2>&1 || true)

if ! grep -q "$ROOT_CONTRACT_ID" <<<"$status_output"; then
  echo "[deploy-gate] FAIL — root contract $ROOT_CONTRACT_ID not found in ledger" >&2
  echo "[deploy-gate] declare the deploy-gate organ before release" >&2
  exit 2
fi

# Extract root status line: "[active|satisfied|...] <id> (shape) ..."
root_line=$(grep -E "^\[[a-z]+\] $ROOT_CONTRACT_ID " <<<"$status_output" | head -1)
root_status=$(echo "$root_line" | sed -E 's/^\[([a-z]+)\].*/\1/')

case "$root_status" in
  satisfied)
    echo "[deploy-gate] PASS — root contract $ROOT_CONTRACT_ID is satisfied; release may proceed"
    exit 0
    ;;
  active|pending|*)
    echo "[deploy-gate] FAIL — root contract $ROOT_CONTRACT_ID status: $root_status" >&2
    echo "[deploy-gate] blockers:" >&2
    # Surface pending children
    grep -E "^\s+\[(pending|active)\] [0-9a-f]{8}" <<<"$status_output" | head -10 | sed 's/^/  /' >&2
    echo >&2
    echo "[deploy-gate] refuse to deploy. Satisfy the gate or set DEPLOY_GATE_BYPASS=1 with a documented reason in the release commit message." >&2
    exit 1
    ;;
esac
