#!/usr/bin/env bash
# capability-backlog-attest.test.sh — the falsifiable SIGN over capability-backlog-attest.sh.
# Proves the firmament invariant: the /contract attestation flows DOWNSTREAM of the real gate exit
# code, so it CANNOT fabricate green. A RED gate must yield a RED attestation (non-zero exit + "(RED)").
# Exits 0 exactly when the invariant holds; mutation-proven (no fake green can survive).
set -uo pipefail
ROOT="/Users/lekt9/Projects/unbrowse-ecosystem/unbrowse"
DOC="$ROOT/docs/UNBROWSE-CAPABILITY-BACKLOG.md"
ATTEST="$ROOT/scripts/capability-backlog-attest.sh"
export ATTEST_TIMEOUT=2   # the substrate declare is bounded; the test asserts RC + verdict, not the receipt
fail=0

echo "── 1. GREEN path: clean doc → attest exits 0 + verdict GREEN ──"
out="$(bash "$ATTEST" /tmp/attest-test-green.receipt 2>&1)"; rc=$?
if [ "$rc" -eq 0 ] && printf '%s' "$out" | grep -q '(GREEN)'; then echo "  ok   green→exit0+GREEN"; else echo "  FAIL green path rc=$rc"; fail=1; fi

echo "── 2. RED path (mutation): fabricated shipped row → attest exits non-zero + verdict RED ──"
printf '\n| 92 | attest-test-fake | x | both | shipped | `NO-SUCH-FILE-attest.zig` | 1 | P0 | red-probe |\n' >> "$DOC"
out="$(bash "$ATTEST" /tmp/attest-test-red.receipt 2>&1)"; rc=$?
git -C "$ROOT" checkout -- "$DOC"   # restore BEFORE asserting (leave no leaven even on failure)
if [ "$rc" -ne 0 ] && printf '%s' "$out" | grep -q '(RED)'; then echo "  ok   red→exit≠0+RED (no fabricated green)"; else echo "  FAIL red path rc=$rc — attestation did NOT propagate red"; fail=1; fi

echo "── 3. restore verified: clean doc → attest green again ──"
bash "$ATTEST" /tmp/attest-test-restore.receipt >/dev/null 2>&1 && echo "  ok   restored→green" || { echo "  FAIL restore"; fail=1; }

echo "── 4. VIA-/CONTRACT guarantee: a green gate actually lands a non-empty receipt (≤55s) ──"
# the lost sheep: checks 1-3 assert RC+verdict; this asserts the /contract attestation REALLY happens.
# MUST start from a cleared receipt — else a STALE receipt from a prior run falsely passes under aiko-down.
R4="$(mktemp)"; : > "$R4"
ATTEST_TIMEOUT=55 bash "$ATTEST" "$R4" >/dev/null 2>&1
if [ -s "$R4" ]; then
  echo "  ok   green→/contract receipt landed ($(cat "$R4"))"
else
  echo "  FAIL green path produced NO /contract receipt — 'via /contract' not witnessed"; fail=1
fi
rm -f "$R4"

[ "$fail" -eq 0 ] && { echo "── ATTEST-SIGN GREEN — /contract attestation cannot fabricate green, and a green lands a real receipt ──"; exit 0; }
echo "── ATTEST-SIGN RED ──"; exit 1
