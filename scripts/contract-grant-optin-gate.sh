#!/usr/bin/env bash
# contract-grant-optin-gate.sh — the grant/RBAC permission policy is OPT-IN per layer/surface:
# one shared guard (grantGate), adopted by an explicit named call. The opted-in SET is auditable
# (each call names its surface). Green when the policy exists across layers + >=1 surface opted in
# + the policy decisions are witnessed (base/grant/denied).
set -uo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"; cd "$ROOT" || exit 2
fail() { echo "GATE RED — $1"; exit 1; }
grep -q 'export function grantGate' src/values/contract-grant.ts || fail "policy: CLI lacks grantGate (the opt-in guard)"
grep -q 'export function grantGate' backend/src/lib/contract-grant.ts || fail "policy: backend lacks grantGate"
echo "ok policy — grantGate exists on CLI + backend (one shared opt-in guard)"
echo "opted-in surfaces (auditable — each names itself):"
git grep -hoE 'surface: "[^"]+"' -- src backend 2>/dev/null | sed 's/surface: /  - /' | sort -u
N=$(git grep -hoE 'grantGate\(\{' -- src backend 2>/dev/null | wc -l | tr -d ' ')
[ "${N:-0}" -ge 1 ] || fail "coverage: no surface has opted into grantGate yet"
echo "ok coverage — $N surface(s) opted in"
( bun test tests/contract-grant.test.ts ) >/tmp/optin.log 2>&1 || { tail -6 /tmp/optin.log; fail "witness: grantGate decisions regressed"; }
echo "ok witness — base→via base, grant→via grant, deny→denied (opt-in policy proven)"
echo "GATE GREEN — grant/RBAC permission is an OPT-IN policy; layers/surfaces adopt it by a named grantGate call"
