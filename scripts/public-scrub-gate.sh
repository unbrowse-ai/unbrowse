#!/usr/bin/env bash
# public-scrub-gate — the witness that the deferred economic layer is absent from
# every PUBLIC-bound artifact. The public story is: internal APIs are free, discovery
# is free, and paid execution settles fairly over x402. The coin and the maintenance-
# network economics are NOT part of the public surface (they live in the gitignored
# internal/ tier, for later). This gate exits 0 only when none of the deferred terms
# appear in any public artifact.
#
# Like leak-guard, the binding is data: PUBLIC_SCAN lists the public surfaces, DEFERRED
# lists the terms that must not appear. internal/ is excluded by construction.
set -uo pipefail
cd "$(dirname "$0")/.."

# Public-bound surfaces a third party reads. internal/ (gitignored) is NOT public.
PUBLIC_SCAN=(
  "README.md"
  "docs"
  "packages/skill/SKILL.md"
  "packages/skill/README.md"
  "paper/crypto-was-all-you-needed.tex"
  "frontend/src/app"
  "frontend/src/lib/generated"
  "frontend/src/components"
)

# 2026-06-04: the FDRY economy + maintenance network are PUBLIC now (token live; the
# paper trilogy + THE_FDRY_ECONOMY.md ship publicly). Removed FDRY, $FDRY, the token
# address, maintenance network, slashing, staking-mechanics, fair launch, bonded route
# trust and proof-of-indexing from the deferred list. This gate now guards only the
# internal working-method vocabulary — never the public economic layer.
DEFERRED=(
  "grain[ -]of[ -]wheat"
)

fail=0
for term in "${DEFERRED[@]}"; do
  for path in "${PUBLIC_SCAN[@]}"; do
    [ -e "$path" ] || continue
    # exclude the gitignored internal tier and build artifacts
    hits=$(grep -rInE "$term" "$path" 2>/dev/null \
      | grep -viE "(^|/)internal/|/\.next/|/node_modules/" || true)
    if [ -n "$hits" ]; then
      echo "  LEAK [$term]:"; echo "$hits" | sed 's/^/    /' | head -6; fail=1
    fi
  done
done

echo
if [ "$fail" -ne 0 ]; then
  echo "[public-scrub-gate] FAIL — a deferred term appears in a public artifact. Scrub it (move to internal/, reframe to x402/free-discovery)."
  exit 1
fi
echo "[public-scrub-gate] PASS — public surface is free-discovery + x402 only; deferred economic layer absent."
