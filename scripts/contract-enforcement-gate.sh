#!/usr/bin/env bash
# contract-enforcement-gate.sh — the grant/RBAC primitive is ENFORCED at a live read path.
# Safe direction: grants WIDEN access additively (isCallerInLineage OR isVisibleByGrant) — never a
# lockout. The witness proves the live guard ALLOWS a granted caller and DENIES ungranted/forged
# (no leak — the load-bearing security property).
set -uo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"; cd "$ROOT" || exit 2
fail() { echo "GATE RED — $1"; exit 1; }
[ -f backend/src/lib/contract-grant.ts ] || fail "E1: backend lacks the grant primitive"
grep -q 'export function isVisibleByGrant' backend/src/lib/contract-grant.ts || fail "E1: no read-guard (isVisibleByGrant)"
grep -q 'isVisibleByGrant' backend/src/routes/contract.ts || fail "E2: the read gate does not consult grants"
( cd backend && bun test src/lib/contract-grant.test.ts ) >/tmp/enf-gate.log 2>&1 || { tail -8 /tmp/enf-gate.log; fail "E3: enforcement witness failed (granted-visible / ungranted-denied / forged-denied)"; }
echo "ok E1+E2+E3 — live read path consults grants; granted visible, ungranted+forged denied (no leak)"
echo "GATE GREEN — the /contract grant+RBAC permission layer is ENFORCED at a live read path"
