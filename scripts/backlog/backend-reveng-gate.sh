#!/usr/bin/env bash
# backend-reveng-gate.sh — witness for backend-reveng.
#
# The node: move the reverse-engineering to the backend — an endpoint that takes
# the OBFUSCATED capture and derives endpoint specs server-side, never seeing a
# secret. Verifies:
#   1. the reveng route module builds (imports the src/ reveng + obfuscation
#      engines from the backend's position),
#   2. server-side reveng derives a spec from a capture WITHOUT leaking any
#      secret (defensive re-obfuscation) AND the route is mounted on /v1 — via
#      the backend test.
set -uo pipefail
cd "$(dirname "$0")/../.."

# 1. The route module builds (cross-package import from src/ resolves).
tmp=$(mktemp -d); trap 'rm -rf "$tmp"' EXIT
if ! bun build backend/src/routes/reveng.ts --target=node --outdir="$tmp" >/dev/null 2>&1; then
  echo "backend-reveng-gate: FAIL — reveng route module does not build"; exit 1
fi

# 2. Server-side reveng on an obfuscated capture (no leak) + route mounted.
if ! (cd backend && bun test tests/reveng-route.test.ts) >/dev/null 2>&1; then
  echo "backend-reveng-gate: FAIL — reveng route test red"; exit 1
fi

echo "backend-reveng-gate: ok — backend revengs the OBFUSCATED capture into endpoint specs server-side, no secret leaks, route mounted on /v1"
exit 0
