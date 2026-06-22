#!/usr/bin/env bash
# contract-grant-gate.sh — /contract NATIVE relationships + permissions between aiko identities.
# A grant is a real ed25519-SIGNED contract (native, not shape); canRead is a crypto permission
# check (forged → denied). Two aikos see each other's data ONLY per a signed grant.
set -uo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"; cd "$ROOT" || exit 2
fail() { echo "GATE RED — $1"; exit 1; }
grep -q 'ed25519Verify' src/values/contract-grant.ts || fail "grant: not natively ed25519-signed (shape-only)"
grep -q 'export function canRead' src/values/contract-grant.ts || fail "grant: no permission check"
( bun test tests/contract-grant.test.ts ) >/tmp/grant-gate.log 2>&1 || { tail -6 /tmp/grant-gate.log; fail "grant witness failed (forged/granted/revoked/expired/scope/lineage)"; }
echo "ok grant — ed25519-signed grants + crypto permission check; forged denied, granted allowed (witnessed)"
echo "GATE GREEN — /contract native relationships + auth: aikos see each other only per signed grant"
