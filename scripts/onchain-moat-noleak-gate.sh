#!/usr/bin/env bash
# onchain-moat-noleak-gate.sh — the load-bearing luminary for the website-as-wrapper vision
# (plan acceptance #4 + firmament boundary 2). The browser chain-reader reads PUBLIC on-chain
# state but must NEVER decrypt or surface plaintext route VALUES — else putting public state
# on-chain would leak the closed moat. Exits 0 only when:
#   G1 no-decrypt — frontend/src/lib/chain/ never imports/calls a decrypt / private-key path.
#   G2 sealed     — the reader treats payload data as sealed base64 (isSealedPayload present).
#   G3 green      — the chain-reader offline test passes.
# Falsifiable: add browser-side decryption (open the seal) and this reddens.
set -uo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"; cd "$ROOT" || exit 2
fail() { echo "GATE RED — $1"; exit 1; }
DIR="frontend/src/lib/chain"
[ -d "$DIR" ] || fail "G0: $DIR missing (chain-reader skin not planted)"

# G1 — the reader must not decrypt / handle private keys / open sealed payloads in the browser
if grep -rnE 'decrypt|payload_crypto|privateKey|secretKey|seal\s*\.\s*open|xchacha|aead' "$DIR" 2>/dev/null | grep -viE 'never decrypt|does not decrypt|sealed|NEVER'; then
  fail "G1 no-decrypt: a decrypt/private-key path appeared in the browser chain reader (moat leak)"
fi
echo "ok G1 no-decrypt — the browser reader holds no decryption / private-key path"

# G2 — sealed-payload discipline present
grep -qE 'isSealedPayload|base64' "$DIR/reader.ts" 2>/dev/null || fail "G2 sealed: reader lost its sealed-payload discipline"
echo "ok G2 sealed — payloads handled as sealed base64, never plaintext"

# G3 — the offline reader test is green
( cd frontend && bun test src/lib/chain/reader.test.ts ) >/tmp/chain-gate.log 2>&1 || { tail -8 /tmp/chain-gate.log; fail "G3 green: chain-reader test failed"; }
echo "ok G3 green — chain-reader offline test passes"
echo "GATE GREEN — the website-as-wrapper reader leaks no moat (pointers + sealed bytes only)"
