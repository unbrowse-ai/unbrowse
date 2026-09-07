#!/usr/bin/env bash
# web-reflects-gate.sh — the public web reflects what the components ACTUALLY are.
#
# The site spent the "fully open until April 2026" era claiming AGPL-3.0 / 100% free
# / no paid tiers. The current truth (docs/OPEN-SOURCE-NOTICE.md) is open-core: the
# CLI client + SDKs are MIT and free to run locally; the capture engine, backend, and
# web app are proprietary; the marketplace settles per-use in USDC over x402. This
# gate fails while the frontend still tells the old story.
#
# Exits 0 exactly when:
#   1. NO stale AGPL license claim anywhere in frontend/src.
#   2. NO absolute "100% free / no paid tiers / no usage credits" misrepresentation.
#   3. The open-core truth is stated (MIT + proprietary/open-core present).
#   4. The drop-in adapters are surfaced in the docs nav.
#   5. visibility-gate.sh is green (the boundary itself is correct + declared).
set -uo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"
FE="frontend/src"
fail=0
section() { echo; echo "=== $1 ==="; }

section "1. no stale AGPL license claim"
agpl=$(grep -rn "AGPL" "$FE" 2>/dev/null || true)
if [ -n "$agpl" ]; then echo "  AGPL-FAIL: stale AGPL claim still on the site:"; echo "$agpl" | sed 's/^/    /'; fail=1
else echo "  clean: no AGPL claim in $FE"; fi

section "2. no absolute free / no-paid-tiers misrepresentation"
freebie=$(grep -rniE "100% free|no paid tiers|no usage credits|free and open source under" "$FE" 2>/dev/null || true)
if [ -n "$freebie" ]; then echo "  FREE-FAIL: absolute free/no-paid claim (paid marketplace exists):"; echo "$freebie" | sed 's/^/    /'; fail=1
else echo "  clean: no absolute free/no-paid claim"; fi

section "3. open-core truth stated (MIT client + proprietary engine/backend)"
if grep -rqi "MIT" "$FE" && grep -rqiE "open-core|proprietary|private repo|closed" "$FE"; then
  echo "  stated: the site declares MIT (open client) + proprietary (engine/backend)"
else echo "  TRUTH-FAIL: the open-core boundary is not stated in $FE"; fail=1; fi

section "4. drop-in adapters surfaced in docs"
if grep -rq "/docs/adapters" "$FE/app/docs/layout.tsx" 2>/dev/null; then echo "  surfaced: docs nav links /docs/adapters"; else echo "  ADAPTERS-FAIL: docs nav does not link /docs/adapters"; fail=1; fi

section "5. visibility boundary correct + declared"
if bash scripts/visibility-gate.sh >/tmp/wrg_vis.out 2>&1; then echo "  visibility-gate: green"; else echo "  VISIBILITY-FAIL (see /tmp/wrg_vis.out)"; fail=1; fi

echo
if [ "$fail" -ne 0 ]; then echo "WEB-REFLECTS-GATE FAIL — the public web does not yet reflect the true open-core boundary."; exit 1; fi
echo "WEB-REFLECTS-GATE PASS — the public web reflects what the components actually are (open-core, paid marketplace)."
