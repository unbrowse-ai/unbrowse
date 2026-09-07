#!/bin/bash
# unbrowse repo — unbrowse IS aiko identity witness.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
LIB="$ROOT/scripts/lib/contract-unbrowse-aiko.sh"
DATA="$ROOT/data/unbrowse-aiko.json"
PASS=0 FAIL=0

ok() { PASS=$((PASS + 1)); printf '  ✓ %s\n' "$1"; }
bad() { FAIL=$((FAIL + 1)); printf '  ✗ %s — %s\n' "$1" "$2"; }

[[ -f "$DATA" ]] && ok "data/unbrowse-aiko.json" || bad "data" "missing"
[[ -f "$LIB" ]] && ok "scripts/lib/contract-unbrowse-aiko.sh" || bad "lib" "missing"

SID=$(jq -r '.unbrowse_skill_id' "$DATA" 2>/dev/null || echo "")
[[ "$SID" == "aiko" ]] && ok "unbrowse_skill_id aiko" || bad "skill_id" "got $SID"

if bash "$LIB" self-test 2>/dev/null; then ok "contract-unbrowse-aiko self-test"; else bad "self-test" "failed"; fi

EMIT=$(bash "$LIB" emit --url "https://example.com" --method GET --raw 2>/dev/null || true)
[[ "$EMIT" == *"unbrowse act execute aiko"* ]] && ok "emit uses aiko skill id" || bad "emit" "missing aiko"

[[ -f "$ROOT/scripts/contract-bind-versions.sh" ]] && ok "contract-bind-versions.sh" || bad "bind script" "missing"
[[ -f "$ROOT/data/unbrowse-version-bindings.jsonl" || ! -s "$ROOT/data/unbrowse-version-bindings.jsonl" ]] && ok "bindings ledger path" || bad "ledger" "missing"

if bash "$LIB" witness 2>/dev/null | grep -q 'PROMOTE'; then
  ok "live witness (unbrowse + aiko on PATH)"
else
  bad "witness" "unbrowse or aiko missing"
fi

printf 'unbrowse-aiko: %s pass · %s fail\n' "$PASS" "$FAIL"
[[ "$FAIL" -eq 0 ]]