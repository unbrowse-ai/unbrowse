#!/usr/bin/env bash
# capability-backlog-attest.sh — declare the backlog gate's verdict on the /contract substrate.
#
# "Everything via /contract": the gate exit code is the GROUND TRUTH (the rock); this records that
# verdict on the substrate. The declare flows DOWNSTREAM of a real green — a RED gate yields a RED
# attestation, never a fabricated green. The aiko binary's stdout (incl. a 402 envelope) is the
# ledger receipt (binary stdout is valid ledger evidence). Two witnesses: gate RC + the receipt.
set -uo pipefail
ROOT="/Users/lekt9/Projects/unbrowse-ecosystem/unbrowse"
GATE="$ROOT/scripts/capability-backlog-gate.sh"
AIKO="$HOME/.claude/skills/contract/scripts/aiko"
RECEIPT="${1:-/tmp/capability-backlog-attest.receipt}"

bash "$GATE" >/dev/null 2>&1; RC=$?
SHA="$(git -C "$ROOT" rev-parse --short HEAD 2>/dev/null || echo unknown)"
if [ "$RC" -eq 0 ]; then V="GREEN"; else V="RED"; fi
CLAIM="capability-backlog gate $V @ $SHA — 6 papers + 7 asks covered; every shipped row has a resolving anchor (no-fake-green firmament)"

# the substrate binary loads a local model and may settle on-chain — bound it so this gate never hangs.
# The gate RC is the truth; the receipt is best-effort ledger evidence.
ATTEST_TIMEOUT="${ATTEST_TIMEOUT:-60}"
echo "[attest] gate RC=$RC ($V); declaring verdict on /contract substrate (<=${ATTEST_TIMEOUT}s)…"
if [ -x "$AIKO" ]; then
  "$AIKO" "$CLAIM" > "$RECEIPT" 2>/dev/null &
  apid=$!
  for _ in $(seq 1 "$ATTEST_TIMEOUT"); do kill -0 "$apid" 2>/dev/null || break; sleep 1; done
  if kill -0 "$apid" 2>/dev/null; then kill "$apid" 2>/dev/null; echo "[attest] substrate declare still settling at ${ATTEST_TIMEOUT}s — receipt partial (gate verdict stands)"; fi
  echo "[attest] receipt → $RECEIPT ($(wc -c <"$RECEIPT" 2>/dev/null | tr -d ' ') bytes)"
else
  echo "[attest] WARN: aiko binary not found at $AIKO — verdict not attested on substrate"
fi

# the gate verdict is the truth; exit with it so a red gate fails the attestation honestly
exit "$RC"
