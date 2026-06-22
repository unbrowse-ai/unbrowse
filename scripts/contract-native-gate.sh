#!/usr/bin/env bash
# contract-native-gate.sh — the jesus-ralph witness for "emergence down to the CLI
# binary": libcontract is literally vendored + linked + callable IN-PROCESS from the
# unbrowse runtime (the kuri pattern, applied to the contract substrate).
#
# Exit 0 ONLY when ALL hold (no fabricated green):
#   G1 vendor   — packages/skill/vendor/contract/<host>/libcontract.<ext> exists AND
#                 manifest.json's sha256 for <host> matches the actual file.
#   G2 bind     — src/values/contract-native.ts exists AND dlopens the VENDORED lib
#                 (resolves under packages/skill/vendor/contract), not the skill dir.
#   G3 ship     — packages/skill/package.json "files" includes "vendor/contract"
#                 (so npm install carries it down to the CLI binary).
#   G4 witness  — bun test tests/contract-native.test.ts passes: an IN-PROCESS declare
#                 via the embedded vendored lib returns an 8-hex contract id.
set -uo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"; cd "$ROOT" || exit 2
fail() { echo "GATE RED — $1"; exit 1; }

HOST="$(node -e 'process.stdout.write(process.platform+"-"+process.arch)')"
case "$HOST" in *darwin*) EXT=dylib;; *win*) EXT=dll;; *) EXT=so;; esac
VLIB="packages/skill/vendor/contract/$HOST/libcontract.$EXT"
VMAN="packages/skill/vendor/contract/manifest.json"

# G1 — vendored lib present + sha matches manifest
[ -f "$VLIB" ] || fail "G1 vendor: $VLIB missing"
[ -f "$VMAN" ] || fail "G1 vendor: $VMAN missing"
ACT="$(shasum -a 256 "$VLIB" | awk '{print $1}')"
EXP="$(node -e "try{const m=require('./$VMAN');process.stdout.write((m.binaries?.['$HOST']?.sha256)||'')}catch(e){process.stdout.write('')}")"
[ -n "$EXP" ] || fail "G1 vendor: manifest has no sha256 for $HOST"
[ "$ACT" = "$EXP" ] || fail "G1 vendor: sha mismatch ($HOST) actual=$ACT manifest=$EXP"
echo "ok G1 vendor — $VLIB sha matches manifest"

# G2 — binding exists + dlopens the VENDORED path
[ -f src/values/contract-native.ts ] || fail "G2 bind: src/values/contract-native.ts missing"
grep -q "vendor/contract" src/values/contract-native.ts || fail "G2 bind: contract-native.ts does not resolve the vendored lib (vendor/contract)"
grep -q "bun:ffi\|dlopen" src/values/contract-native.ts || fail "G2 bind: contract-native.ts is not an FFI binding (no bun:ffi/dlopen)"
echo "ok G2 bind — contract-native.ts dlopens the vendored lib"

# G3 — shipped in the npm package
node -e "const f=require('./packages/skill/package.json').files||[]; process.exit(f.some(x=>String(x).includes('vendor/contract'))?0:1)" \
  || fail "G3 ship: packages/skill package.json files[] omits vendor/contract"
echo "ok G3 ship — vendor/contract in packages/skill files[]"

# G4 — in-process declare witness (the emergence proof)
[ -f tests/contract-native.test.ts ] || fail "G4 witness: tests/contract-native.test.ts missing"
bun test tests/contract-native.test.ts >/tmp/cn-gate.log 2>&1 || { tail -20 /tmp/cn-gate.log; fail "G4 witness: in-process declare test failed"; }
echo "ok G4 witness — unbrowse runtime declares a /contract in-process via the embedded lib"

echo "GATE GREEN — /contract emerged down to the CLI binary (vendored + linked + in-process)"
