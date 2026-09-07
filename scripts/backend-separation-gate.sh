#!/usr/bin/env bash
# backend-separation-gate.sh — the backend is a SEPARATE repo; nothing of our
# servers leaks; ZK makes the public surface auditable instead.
#
# The open-core boundary (sp-opencore): client -> stable HTTP API -> closed
# backend. This gate proves the seam is clean enough that backend/ can live in its
# own repo with the open client never reaching into it:
#   1. SEAM    — no public source (src/, packages/*/src) imports backend source.
#                The client knows the backend only through the wire contract + HTTP.
#   2. LEAK    — scripts/leak-guard.sh exits 0 (no server internals in any public path).
#   3. SEPARABLE — backend/ is its own deploy unit (package.json + wrangler.toml)
#                and is NOT bundled into any published npm package's `files`.
#   4. AUDITABLE — the public ZK / hash-chain references pass, so trust is provable
#                without exposing the server (ZK is enough).
#
# Exit 0 iff all hold. No string fakes it: the SEAM check greps real imports.
set -uo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"
fail=0
section() { echo; echo "=== $1 ==="; }

# --- 1. SEAM ------------------------------------------------------------------
section "1. seam — no public source imports backend source"
seam=$(grep -rnE "(from|import|require)[^\n]*['\"][^'\"]*\.\./backend/|['\"][^'\"]*/backend/src/" \
        src packages --include=*.ts --include=*.tsx --include=*.js --include=*.mjs 2>/dev/null \
        | grep -v node_modules | grep -vE '^\s*//|^\s*\*' || true)
if [ -n "$seam" ]; then
  echo "  SEAM-FAIL: public source reaches into backend/ (breaks a separate repo):"
  echo "$seam" | sed 's/^/    /'
  fail=1
else
  echo "  seam clean: the open client imports no backend source"
fi

# --- 2. LEAK ------------------------------------------------------------------
section "2. leak-guard — no server internals in public paths"
if bash scripts/leak-guard.sh >/tmp/bsg_leak.out 2>&1; then
  echo "  leak-guard: clean"
else
  echo "  LEAK-FAIL: scripts/leak-guard.sh did not exit 0 (see /tmp/bsg_leak.out)"; fail=1
fi

# --- 3. SEPARABLE -------------------------------------------------------------
section "3. backend is its own deploy unit, not bundled into a published package"
if [ -f backend/package.json ] && [ -f backend/wrangler.toml ]; then
  echo "  deploy unit: backend/{package.json,wrangler.toml} present"
else
  echo "  SEPARABLE-FAIL: backend is not a standalone deploy unit"; fail=1
fi
# no published npm package may list backend in its files allow-list
bundled=$(grep -rl '"backend' packages/*/package.json 2>/dev/null | while read -r pj; do
  python3 -c "import json,sys; f=json.load(open('$pj')).get('files',[]); print('$pj') if any('backend' in str(x) for x in f) else None" 2>/dev/null
done)
if [ -n "$bundled" ]; then
  echo "  SEPARABLE-FAIL: a published package bundles backend:"; echo "$bundled" | sed 's/^/    /'; fail=1
else
  echo "  no published package bundles backend/"
fi

# --- 4. AUDITABLE (ZK is enough) ----------------------------------------------
section "4. ZK / hash-chain references make trust auditable without the server"
PY="$(command -v python3 || command -v python)"
zk_ok=1
for t in test_zk_binding.py test_ledger.py test_proof_of_indexing.py test_checkpoint.py; do
  if "$PY" "paper/reference/tests/$t" >/dev/null 2>&1; then
    echo "  PASS: $t"
  else
    echo "  AUDIT-FAIL: $t did not pass"; zk_ok=0; fail=1
  fi
done
[ "$zk_ok" -eq 1 ] && echo "  auditable: trust is provable by ZK + hash-chain, no server source needed"

echo
if [ "$fail" -ne 0 ]; then
  echo "BACKEND-SEPARATION-GATE FAIL — the backend cannot cleanly live in a separate repo yet."
  exit 1
fi
echo "BACKEND-SEPARATION-GATE PASS — backend is a separable, non-leaking repo; the public surface is ZK-auditable."
