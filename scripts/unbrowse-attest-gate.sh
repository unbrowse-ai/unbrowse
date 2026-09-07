#!/usr/bin/env bash
# unbrowse-attest-gate.sh — the two-witness seal for build attestation.
#
# Mirrors the project's other *-gate.sh witnesses (pay-sh-gate, crypto-
# completion-gate): exit 0 ONLY when both witnesses agree, never a fabricated
# green. For each requested build kind:
#
#   witness A (local):    attest/build-ledger.jsonl lineage verifies (every row's
#                         Ed25519 wallet sig valid + parent_sha chain unbroken)
#   witness B (on-chain): the head row's artifact sha is present in the IQLabs
#                         Solana build-attest:<kind> table
#
# Appends an honest result line to attest/gate-history.jsonl every run.
#
# Usage:
#   bash scripts/unbrowse-attest-gate.sh                       # cli + server, strict
#   bash scripts/unbrowse-attest-gate.sh --cli                 # cli only
#   bash scripts/unbrowse-attest-gate.sh --allow-iq-unconfigured  # 1-witness pass when IQ absent

set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
ATTEST="$ROOT_DIR/src/values/build-attest.ts"
HIST="$ROOT_DIR/attest/gate-history.jsonl"

KINDS=(); ALLOW=""
for a in "$@"; do
  case "$a" in
    --cli)    KINDS+=("cli") ;;
    --server) KINDS+=("server") ;;
    --allow-iq-unconfigured) ALLOW="--allow-iq-unconfigured" ;;
    *) echo "unknown arg: $a" >&2; exit 2 ;;
  esac
done
[[ ${#KINDS[@]} -eq 0 ]] && KINDS=("cli" "server")

RC=0
for kind in "${KINDS[@]}"; do
  # A kind with no rows yet is skipped, not failed (server may be unattested locally).
  if ! ( cd "$ROOT_DIR" && bun "$ATTEST" verify --kind "$kind" ) >/dev/null 2>&1; then
    echo "[gate] $kind: no local lineage yet — skipped"
    continue
  fi
  if ( cd "$ROOT_DIR" && bun "$ATTEST" gate --kind "$kind" $ALLOW ); then
    echo "[gate] $kind: SEALED"
  else
    echo "[gate] $kind: NOT SEALED"; RC=1
  fi
done

mkdir -p "$ROOT_DIR/attest"
TS="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
printf '{"ts":"%s","kinds":"%s","allow_unconfigured":"%s","exit":%d}\n' "$TS" "${KINDS[*]}" "${ALLOW:-0}" "$RC" >> "$HIST"

if [[ "$RC" == "0" ]]; then echo "[gate] two-witness seal: GREEN"; else echo "[gate] two-witness seal: RED"; fi
exit $RC
