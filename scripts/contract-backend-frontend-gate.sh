#!/usr/bin/env bash
# contract-backend-frontend-gate.sh — the LAST two in-repo layers settle as /contract:
# the backend API responses and the frontend surfaces carry the three-shape verdict, using the
# SAME pure deriver shape as the CLI (contract-shape). Separate deploy artifacts (CF workers) each
# carry their own copy of the pure shape — legitimate, not duplication-of-logic (the shape is the
# canonical /contract verdict; a worker cannot import the CLI's src/).
#   B1 backend serves the /contract substrate (already)         — routes/contract.ts + contract-ledger
#   B2 backend has the verdict shape + attaches it to a response
#   F1 frontend has the verdict shape
#   F2 a frontend surface actually uses it (not dead code)
set -uo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"; cd "$ROOT" || exit 2
fail() { echo "GATE RED — $1"; exit 1; }

[ -f backend/src/routes/contract.ts ] && [ -f backend/src/services/contract-ledger.ts ] || fail "B1: backend no longer serves the /contract substrate"
echo "ok B1 backend — serves the /contract substrate (routes/contract.ts + contract-ledger)"

[ -f backend/src/lib/contract-shape.ts ] || fail "B2: backend lacks the verdict shape (contract-shape.ts)"
grep -q 'contractVerdictFromEnvelope' backend/src/lib/contract-shape.ts || fail "B2: backend contract-shape missing the deriver"
git grep -lq 'contractVerdictFromEnvelope\|_contract' -- backend/src/index.ts backend/src/routes 2>/dev/null || fail "B2: backend does not attach the verdict to a response"
echo "ok B2 backend — API responses carry the three-shape verdict"

[ -f frontend/src/lib/contract-shape.ts ] || fail "F1: frontend lacks the verdict shape"
grep -q 'contractVerdictFromEnvelope' frontend/src/lib/contract-shape.ts || fail "F1: frontend contract-shape missing the deriver"
echo "ok F1 frontend — carries the verdict shape"

git grep -lq 'contractVerdictFromEnvelope\|contract-shape' -- frontend/src/app frontend/src/components 2>/dev/null || fail "F2: no frontend surface uses the verdict (dead code)"
echo "ok F2 frontend — a surface uses the verdict (not dead code)"

echo "GATE GREEN — backend + frontend layers settle as /contract (same verdict shape as the CLI)"
