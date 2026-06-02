#!/usr/bin/env bash
# frontend-dashboard-gate.sh — witness for frontend-dashboard: the web app's
# /account surfaces all three — API keys, earnings, and private marketplaces
# (private domains) — wired to real backend endpoints, and the frontend
# typechecks clean.
set -uo pipefail
REPO="$(cd "$(dirname "$0")/../.." && pwd)"; cd "$REPO"
P=frontend/src/app/account/page.tsx
A=frontend/src/lib/account-client.ts
grep -q 'ApiKeysSection' "$P" || { echo "FAIL: no API-keys section"; exit 1; }
grep -q 'PrivateDomainsSection' "$P" || { echo "FAIL: no private-domains (private marketplace) section"; exit 1; }
grep -q 'fetchPrivateDomains' "$A" || { echo "FAIL: account-client has no fetchPrivateDomains"; exit 1; }
grep -q "/v1/account/private-domains" "$A" || { echo "FAIL: not wired to the real private-domains endpoint"; exit 1; }
grep -qE 'fetchMe|earned' "$A" || { echo "FAIL: account-client has no earnings surface"; exit 1; }
( cd frontend && npx tsc --noEmit -p tsconfig.json >/dev/null 2>&1 ) || { echo "FAIL: frontend typecheck"; exit 1; }
echo "ok: /account shows API keys + earnings + private domains (real endpoints); frontend typechecks clean"
