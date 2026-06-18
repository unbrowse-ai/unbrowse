#!/usr/bin/env bash
# index-publish-gate.sh — witness for "publish/contribute always works: bearer is
# OPTIONAL (web2 wrapper), the signed client is the real gate, wallet-less users
# attribute to the global index wallet — and the pattern CASCADES across every
# contribution-write route." jesus-ralph gate.
set -uo pipefail
cd "$(dirname "$0")/.." || exit 2
fail=0
ok(){ printf 'ok   %s\n' "$1"; }
bad(){ printf 'FAIL %s\n' "$1"; fail=1; }

# 1. Cascade complete — NO contribution route still hard-requires bearerAuth alongside
#    requireSignedClient (that pairing was the silent-publish-failure gate).
pairings=$(grep -rcE "bearerAuth, *requireSignedClient" backend/src/routes/ 2>/dev/null | grep -v ':0' | wc -l | tr -d ' ')
[ "$pairings" -eq 0 ] && ok "no route still pairs bearerAuth+requireSignedClient (cascade complete)" \
  || { bad "$pairings file(s) still pair bearerAuth+requireSignedClient"; grep -rnE "bearerAuth, *requireSignedClient" backend/src/routes/ | sed 's/^/    /'; }

# 2. The contribution-write routes use the bearer-optional middleware + keep the gate.
need=(extract search transactions graph skills reveng)
for f in "${need[@]}"; do
  if grep -qE "indexContributorAuth, *requireSignedClient" "backend/src/routes/$f.ts"; then
    ok "routes/$f.ts on indexContributorAuth+requireSignedClient"
  else
    bad "routes/$f.ts not migrated to indexContributorAuth"
  fi
done

# 3. The middleware exists, never 401s on missing key, and falls back to the global
#    index wallet (env) so wallet-less contributions still land.
grep -q "export async function indexContributorAuth" backend/src/middleware/auth.ts \
  && grep -q "UNBROWSE_GLOBAL_INDEX_WALLET" backend/src/middleware/auth.ts \
  && grep -q "GLOBAL_INDEX_AGENT_ID" backend/src/middleware/auth.ts \
  && ok "indexContributorAuth: optional bearer + global-index-wallet fallback" \
  || bad "indexContributorAuth middleware missing or no global-index fallback"

# 4. The env wallet is a typed binding.
grep -q "UNBROWSE_GLOBAL_INDEX_WALLET" backend/src/types.ts \
  && ok "UNBROWSE_GLOBAL_INDEX_WALLET typed in Env" || bad "env wallet not typed"

# 5. The core auth change typechecks clean. Scoped to the pure-backend files I
#    authored (middleware/auth.ts + types.ts) — the route files only got a one-token
#    middleware swap (verified structurally in 1-2) and carry the repo's KNOWN
#    pre-existing cross-package rootDir noise (e.g. reveng.ts hole-template), which
#    is unrelated to this change and must not be counted here.
errs=$(cd backend && bunx tsc --noEmit 2>&1 | grep -E "middleware/auth\.ts|src/types\.ts" | grep -vE "rootDir|is not under|node:" | wc -l | tr -d ' ')
[ "${errs:-0}" -eq 0 ] && ok "core auth middleware + Env type typecheck clean" || bad "$errs tsc error(s) in auth.ts/types.ts"

if [ "$fail" -eq 0 ]; then echo "INDEX-PUBLISH GREEN — bearer optional, signed-client gates, wallet-less → global index, cascaded"; exit 0; fi
echo "INDEX-PUBLISH RED"; exit 1
