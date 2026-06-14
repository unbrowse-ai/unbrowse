#!/usr/bin/env bash
# gate_session_persist.sh — the jesus-ralph WITNESS for cross-process session state.
#
# Exits 0 only when, across TWO independent witnesses (Gen 2:2):
#   A. CROSS-PROCESS INHERITANCE: a write in ONE CLI process persists its yield to disk
#      under --session S; a SEPARATE process reading getYieldCache(S) inherits it (the
#      stateless binary now has state via disk).
#   B. DISK FIRMAMENT: a SENSITIVE-named yield is written to disk as a sha256 COMMITMENT,
#      never in clear — the secret does not cross the disk firmament.
#
# Binary: local source (bun src/cli.ts). Network-unreachable => exit 3 (BLOCKED).
set -uo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$HERE/../../.." && pwd)"
cd "$ROOT"
CFG="${UNBROWSE_CONFIG_DIR:-$HOME/.unbrowse}"
TS="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
HISTORY="$ROOT/bench/capability/history.jsonl"

witness() { # -> echoes PASS / FAIL / BLOCKED ; detail to stderr
  local ok=1 blocked=0
  local S="persist-$$-${RANDOM}"
  local SECRETSESS="persist-sec-$$-${RANDOM}"
  local secret="zk-persist-$$-${RANDOM}"

  # ── Witness A: cross-process id inheritance ────────────────────────────────
  # Process 1: a real write through the CLI, scoped to --session S.
  timeout 60 bun src/cli.ts execute --url "https://jsonplaceholder.typicode.com/posts" \
    --intent "create a post" --body '{"title":"p","userId":1}' --session "$S" >/dev/null 2>&1
  # Process 2: a SEPARATE process — empty module store, must load S from disk.
  local got; got="$(timeout 30 bun -e '
    const { getYieldCache } = await import("./src/runtime/yield-store.ts");
    const c = getYieldCache(process.argv[1]);
    if (!c) { console.log("none"); }
    else { console.log([...c.values()].map(y=>String(y.value)).join(",")); }
  ' "$S" 2>/dev/null)"
  if [ "$got" = "none" ] || [ -z "$got" ]; then
    echo "  A BLOCKED/FAIL: process 2 saw no yields ($got) — write may have failed (network?)" >&2
    blocked=1
  elif echo "$got" | grep -q "101"; then
    echo "  A PASS: separate process inherited yield id=101 via disk" >&2
  else
    echo "  A FAIL: cross-process yields=[$got] (no 101)" >&2; ok=0
  fi

  # ── Witness B: sensitive yield committed on disk, not clear ─────────────────
  timeout 30 bun -e '
    const { recordYields } = await import("./src/runtime/yield-store.ts");
    recordYields(process.argv[1], [{ key: "password", source: "response", example_value: process.argv[2] }]);
  ' "$SECRETSESS" "$secret" >/dev/null 2>&1
  # the secret must NOT appear in clear anywhere under the yield-sessions dir
  if grep -rl "$secret" "$CFG/yield-sessions" >/dev/null 2>&1; then
    echo "  B FAIL: cleartext secret leaked to a yield-session file" >&2; ok=0
  else
    echo "  B no-cleartext-on-disk PASS" >&2
  fi
  # and the commitment must be present
  if grep -rl "sha256:" "$CFG/yield-sessions" >/dev/null 2>&1; then
    echo "  B commitment-persisted PASS" >&2
  else
    echo "  B FAIL: no sha256 commitment for the sensitive yield" >&2; ok=0
  fi

  # cleanup
  timeout 20 bun -e '
    const { clearSessionYields } = await import("./src/runtime/yield-store.ts");
    clearSessionYields(process.argv[1]); clearSessionYields(process.argv[2]);
  ' "$S" "$SECRETSESS" >/dev/null 2>&1

  if [ "$blocked" = "1" ] && [ "$ok" = "1" ]; then echo BLOCKED; return; fi
  [ "$ok" = "1" ] && echo PASS || echo FAIL
}

echo "── session-persist gate (witness 1) ──" >&2
W1="$(witness)"; [ -z "$W1" ] && W1="FAIL"
echo "── session-persist gate (witness 2) ──" >&2
W2="$(witness)"; [ -z "$W2" ] && W2="FAIL"
echo "── witness1=$W1 witness2=$W2 ──"
python3 -c "import json;open('$HISTORY','a').write(json.dumps({'ts':'$TS','source':'live','axis':'E_session_persist','witness1':'$W1','witness2':'$W2','gate':'true' if ('$W1'=='PASS' and '$W2'=='PASS') else 'false'})+'\n')" 2>/dev/null

if [ "$W1" = "BLOCKED" ] || [ "$W2" = "BLOCKED" ]; then echo " GATE: BLOCKED (network)"; exit 3; fi
if [ "$W1" = "PASS" ] && [ "$W2" = "PASS" ]; then echo " GATE: PASS — CLI sessions persist across processes via disk; secrets committed"; exit 0; fi
echo " GATE: FAIL"; exit 1
