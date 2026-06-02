#!/usr/bin/env bash
# stateless-binary-gate.sh — witness for stateless-binary.
#
# The node (the user's "unbrowse binary needs to be stateless"): under
# UNBROWSE_STATELESS=1 the binary holds NO local persisted state — the
# suppressible local-disk writes are skipped, the backend KV / sealed cache is
# the source of truth. Establishes the one isStateless() gate and closes the
# previously-unguarded execution-trace write (it left ~/.unbrowse/traces on disk
# even in stateless mode). Verifies:
#   1. the stateless helper + trace-store build,
#   2. isStateless() reads the flag correctly AND storeExecutionTrace writes NO
#      local file under UNBROWSE_STATELESS=1 (disk stays clean), writes normally
#      otherwise — via the test.
set -uo pipefail
cd "$(dirname "$0")/../.."

tmp=$(mktemp -d); trap 'rm -rf "$tmp"' EXIT
if ! bun build src/state/stateless.ts src/graph/trace-store.ts src/api/session-store.ts --target=node --outdir="$tmp" >/dev/null 2>&1; then
  echo "stateless-binary-gate: FAIL — stateless / trace-store / session-store modules do not build"; exit 1
fi

if ! bun test tests/stateless-mode.test.ts >/dev/null 2>&1; then
  echo "stateless-binary-gate: FAIL — stateless-mode test red"; exit 1
fi

echo "stateless-binary-gate: ok — UNBROWSE_STATELESS=1 suppresses local trace persistence (disk stays clean); isStateless() is the one gate"
exit 0
