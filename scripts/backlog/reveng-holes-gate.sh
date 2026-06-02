#!/usr/bin/env bash
# reveng-holes-gate.sh — witness for reveng-exposes-holes.
#
# The node: WIRE the hole-template into the live /v1/reveng endpoint so the
# backend, after revenging the obfuscated capture, hands the client ONLY the
# holes to fill (the user's "we only EXPOSE what is needed to the client").
# Verifies (via the reveng route test):
#   1. revengWithHoles returns per-request holes carrying NO secret,
#   2. the client can fill those holes locally back into a concrete request,
#   3. the /v1/reveng HTTP response includes holes end-to-end and leaks no secret.
set -uo pipefail
cd "$(dirname "$0")/../.."

tmp=$(mktemp -d); trap 'rm -rf "$tmp"' EXIT
if ! bun build backend/src/routes/reveng.ts --target=node --outdir="$tmp" >/dev/null 2>&1; then
  echo "reveng-holes-gate: FAIL — reveng route module does not build"; exit 1
fi

if ! (cd backend && bun test tests/reveng-route.test.ts) >/dev/null 2>&1; then
  echo "reveng-holes-gate: FAIL — reveng route test red"; exit 1
fi

echo "reveng-holes-gate: ok — /v1/reveng exposes only the holes to fill (no secret), client fills them locally, end-to-end"
exit 0
