#!/usr/bin/env bash
# Witness: Cascade (@cascade-fyi splits SDK) is removed; only Faremeter Flex remains.
# Exit 0 iff no active source/dep references the cascade splits SDK AND the payment
# + client surfaces still typecheck/test. CASCADE_RPC_URL/SIGNER env (reused by Flex
# as the Solana RPC/signer) are intentionally NOT removed.
set -uo pipefail
cd "$(dirname "$0")/.."
fail=0
echo "=== no @cascade-fyi splits SDK in active source or deps ==="
hits=$(git grep -nE '@cascade-fyi|payments/cascade|services/cascade\.js|ensureCascadeSplitForSkill|ensureSkillCascadeSplit' \
  -- src backend/src packages/skill/src packages/skill/bin package.json packages/skill/package.json 2>/dev/null \
  | grep -v 'cascade-removed-gate' || true)
if [ -n "$hits" ]; then echo "  FAIL — cascade refs remain:"; echo "$hits" | sed 's/^/    /' | head; fail=1; else echo "  ok — no cascade splits-SDK refs"; fi
echo "=== cascade source files deleted ==="
for f in backend/src/services/cascade.ts src/payments/cascade.ts; do [ -e "$f" ] && { echo "  FAIL — $f still present"; fail=1; } || echo "  ok — $f gone"; done
echo "=== payment surface still builds (flex client typecheck) ==="
if bun build src/client/index.ts --target=node --outfile=/dev/null >/tmp/cas-build.log 2>&1; then echo "  ok — client builds"; else echo "  FAIL — client build:"; tail -4 /tmp/cas-build.log|sed 's/^/    /'; fail=1; fi
echo
[ "$fail" -ne 0 ] && { echo "[cascade-removed-gate] NOT YET"; exit 1; }
echo "[cascade-removed-gate] PASS — Cascade removed; Faremeter Flex is the only payment rail."
