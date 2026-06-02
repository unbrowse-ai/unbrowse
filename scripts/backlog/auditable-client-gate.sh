#!/usr/bin/env bash
# auditable-client-gate.sh — witness for auditable-client.
#
# The node: the open client surfaces the obfuscation PROVABLY — the user can
# audit that every secret is redacted + wallet-bound BEFORE anything leaves the
# machine, and the gate refuses to send an unsafe payload. Verifies:
#   1. the audit + gate modules build (pure, transparent — no I/O),
#   2. the audit CATCHES a secret the redaction heuristics miss, the user's
#      vault secrets close the gap (provably safe), the gate REFUSES on leak,
#      and safe redactions are wallet-bound — via the test.
set -uo pipefail
cd "$(dirname "$0")/../.."

# 1. The audit + gate build.
tmp=$(mktemp -d); trap 'rm -rf "$tmp"' EXIT
if ! bun build src/capture/obfuscate-audit.ts --target=node --outdir="$tmp" >/dev/null 2>&1; then
  echo "auditable-client-gate: FAIL — obfuscate-audit module does not build"; exit 1
fi

# 2. The provable-safety properties hold.
if ! bun test tests/obfuscate-audit.test.ts >/dev/null 2>&1; then
  echo "auditable-client-gate: FAIL — obfuscate-audit test red"; exit 1
fi

echo "auditable-client-gate: ok — audit catches heuristic-missed secrets, vault secrets close the gap, gate refuses unsafe sends, safe redactions wallet-bound"
exit 0
