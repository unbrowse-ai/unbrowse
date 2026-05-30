#!/bin/bash
# cross: sha256:b35fea21e179afd6de983a90f4c1575527619b2d0143edd7d31b0dd70d8a97f5  (the seal plane inherits the cross — pointer not payload; verify via .claude/superpattern/cross-stamp-gate.sh)
# client-audit-gate.sh — Gate 5: the @unbrowse/client OSS surface is auditable + leaks zero moat.
#
# Two mechanical checks, no fake-green:
#   (1) COMPLETENESS — every public export in packages/sdk-v2/src/index.ts has a row
#       in paper/client-audit.tsv. A new public symbol with no audit row fails the gate,
#       so the audit map can never silently fall behind the surface (seed-bearing, like paper-gate).
#   (2) NO MOAT LEAK — the client source (packages/sdk-v2/src/*.ts) carries none of the
#       moat terms (capture/RE engine internals, route-inference internals, economic
#       constants, covenant secrets, zk circuit, signer/private keys). The client is
#       HTTP-first; if any of these appear, the moat boundary has been breached.
#
# Exit 0 = auditable + clean. Exit 1 = unaudited surface or moat leak.
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
# Paths are overridable via env so the gate is falsifiable (a mutation test can
# point it at fixtures with an unaudited export or an injected moat term and
# confirm it fails-closed). Unset = the real client surface (default behavior).
INDEX="${CLIENT_AUDIT_INDEX:-$ROOT/packages/sdk-v2/src/index.ts}"
AUDIT="${CLIENT_AUDIT_TSV:-$ROOT/paper/client-audit.tsv}"
SRC_DIR="${CLIENT_AUDIT_SRC:-$ROOT/packages/sdk-v2/src}"

[[ -f "$INDEX" ]] || { echo "client-audit-gate: missing $INDEX" >&2; exit 1; }
[[ -f "$AUDIT" ]] || { echo "client-audit-gate: missing $AUDIT" >&2; exit 1; }

fail=0

echo "=== client-audit-gate: $AUDIT ==="

# (1) COMPLETENESS — extract every exported identifier from index.ts export {...} blocks
#     (flatten newlines, pull the brace groups, split on commas, strip whitespace).
EXPORTS=$(tr '\n' ' ' < "$INDEX" \
  | grep -oE 'export (type )?\{[^}]*\}' \
  | sed -E 's/export (type )?\{//; s/\}//' \
  | tr ',' '\n' \
  | sed -E 's/[[:space:]]//g' \
  | grep -vE '^$' | sort -u || true)

n_exports=0
n_missing=0
while IFS= read -r name; do
  [[ -z "$name" ]] && continue
  n_exports=$((n_exports + 1))
  if ! grep -qE "^${name}"$'\t' "$AUDIT"; then
    echo "  ✗ UNAUDITED public export (no row in client-audit.tsv): $name"
    n_missing=$((n_missing + 1))
    fail=1
  fi
done <<< "$EXPORTS"
echo "  reflect: $n_exports public export(s), $n_missing unaudited"

# (1b) No row may have an empty moat-safe-reason column (4 tab-separated fields).
empties=$(grep -vE '^#' "$AUDIT" | grep -vE '^[[:space:]]*$' \
  | awk -F'\t' 'NF<4 || $4=="" {print $1}' || true)
if [[ -n "$empties" ]]; then
  echo "  ✗ rows with no moat-safe reason:"; echo "$empties" | sed 's/^/      /'
  fail=1
fi

# (2) NO MOAT LEAK — scan the client source for moat terms.
MOAT_TERMS=(
  "capture engine" "captureEngine" "reverse-engineer" "reverseEngineer"
  "route inference" "routeInference" "zk circuit" "zkCircuit" "snark" "groth16"
  "OPERATOR_BPS" "DISCOVERER_BPS" "OWNER_BPS" "covenant secret" "covenantSecret"
  "private key" "privateKey" "signer.ts" "IPROYAL" "iproyal"
)
leak=0
for term in "${MOAT_TERMS[@]}"; do
  hits=$(grep -rIl -- "$term" "$SRC_DIR" 2>/dev/null || true)
  if [[ -n "$hits" ]]; then
    echo "  ✗ MOAT TERM in client source ($term):"; echo "$hits" | sed 's/^/      /'
    leak=$((leak + 1)); fail=1
  fi
done
echo "  no-leak: scanned ${#MOAT_TERMS[@]} moat term(s), $leak leaked"

if [[ "$fail" -eq 0 ]]; then
  echo "CLIENT-AUDIT-GATE PASS — every public export is audited; no moat term leaked."
  exit 0
fi
echo "CLIENT-AUDIT-GATE FAIL — see findings above." >&2
exit 1
