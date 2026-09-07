#!/bin/bash
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
DATA="$ROOT/data/aiko-sync-byte.json"
PASS=0 FAIL=0
ok() { PASS=$((PASS+1)); printf '  ✓ %s\n' "$1"; }
bad() { FAIL=$((FAIL+1)); printf '  ✗ %s — %s\n' "$1" "$2"; }

[[ -f "$DATA" ]] && ok "aiko-sync-byte.json" || bad "data" "missing"
[[ "$(jq -r .semantic_byte "$DATA")" == "53" ]] && ok "semantic_byte 53" || bad "byte" "not 53"
[[ -f "$ROOT/scripts/contract-sync-heartbeat.sh" ]] && ok "sync heartbeat script" || bad "script" "missing"

LOCAL=$(jq -r .version "$ROOT/version.json")
NPM=$(curl -fsSL 'https://registry.npmjs.org/unbrowse' | python3 -c "import sys,json; print(json.load(sys.stdin)['dist-tags']['latest'])")
MANIFEST=$(jq -r '.version_bindings.latest' "$ROOT/data/unbrowse-aiko.json")
[[ "$LOCAL" == "$NPM" && "$MANIFEST" == "$NPM" ]] && ok "versions in tune ($NPM)" || bad "drift" "local=$LOCAL npm=$NPM manifest=$MANIFEST"

printf 'aiko-sync-byte: %s pass · %s fail\n' "$PASS" "$FAIL"
[[ "$FAIL" -eq 0 ]]