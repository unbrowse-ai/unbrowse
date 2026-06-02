#!/usr/bin/env bash
# single-sdk-search-gate.sh — runnable witness for the north star:
#   ONE SDK (folded into the `unbrowse` package, no confusing second SDK) +
#   a single Exa-backed search-on-top, paid per-request via x402/faremeter with
#   the existing 50/35/15 platform/indexer/owner split + benchmarks/skills/docs/
#   whitepaper updated to match (no wrong whitepaper claims).
#
# Exits 0 ONLY when every node settles. Granular: each check prints PASS/FAIL so
# partial progress is visible across loop turns.
set -uo pipefail
REPO="$(cd "$(dirname "$0")/.." && pwd)"; cd "$REPO"
fail=0
pass(){ printf '\033[32mPASS\033[0m %s\n' "$1"; }
bad(){ printf '\033[31mFAIL\033[0m %s\n' "$1"; fail=1; }
sec(){ printf '\n— %s —\n' "$1"; }

PKG=packages/skill/package.json

sec "A. ONE SDK — folded into the \`unbrowse\` package"
# A1: the unbrowse package exposes a real programmatic SDK surface.
if node -e "const p=require('./$PKG'); const e=p.exports||{}; process.exit((p.main||e['.']||e['./sdk'])?0:1)" 2>/dev/null \
   && ls packages/skill/src/sdk/index.ts >/dev/null 2>&1; then
  pass "A1: \`unbrowse\` package exposes an SDK surface (exports + src/sdk/index.ts)"
else
  bad "A1: \`unbrowse\` package has no SDK surface yet (need exports + packages/skill/src/sdk/index.ts)"
fi
# A2: no separately-published sdk / sdk-v2 in the public sync. Scope to the
# PUBLIC_PKGS(...) array block only (avoid the docs/sdk dir + comments); match
# whole tokens so `ai-sdk` doesn't false-trigger.
PKG_ARRAY=$(awk '/^PUBLIC_PKGS=\(/{f=1} f{print} f&&/\)/{exit}' scripts/open-core-sync.sh)
if printf '%s' "$PKG_ARRAY" | grep -qE '[( ]sdk(-v2)?[ )]'; then
  bad "A2: open-core-sync.sh PUBLIC_PKGS still lists a separate sdk/sdk-v2 package"
else
  pass "A2: no separate sdk/sdk-v2 in the public open-core sync"
fi
# A3: README presents ONE SDK, not two parallel installs.
if grep -q '@unbrowse/sdk' README.md && grep -q '@unbrowse/client' README.md; then
  bad "A3: README still advertises two SDKs (@unbrowse/sdk AND @unbrowse/client)"
else
  pass "A3: README presents a single SDK surface"
fi
# A4: shims don't depend on a separate SDK package.
shim_dep=0
for s in firecrawl-shim playwright-shim stagehand-shim tavily-shim exa-shim; do
  [ -f "packages/$s/package.json" ] || continue
  if node -e "const d=require('./packages/$s/package.json').dependencies||{}; process.exit((d['@unbrowse/sdk']||d['@unbrowse/client'])?0:1)" 2>/dev/null; then
    bad "A4: packages/$s still depends on a separate SDK package"; shim_dep=1
  fi
done
[ "$shim_dep" -eq 0 ] && pass "A4: no shim depends on a separate @unbrowse/sdk or @unbrowse/client"

sec "B. SEARCH-ON-TOP — Exa-backed, x402-paid, 50/35/15 split"
# B1: a single search surface (CLI `unbrowse search` + MCP `unbrowse_search`).
cli_search=0; grep -qE 'case "search"|cmd === "search"|=== ?.search.\b' src/cli.ts 2>/dev/null && cli_search=1
mcp_search=0; grep -qE 'name: "unbrowse_search"' src/mcp.ts 2>/dev/null && mcp_search=1
if [ "$cli_search" -eq 1 ] && [ "$mcp_search" -eq 1 ]; then
  pass "B1: single search surface present (CLI \`unbrowse search\` + MCP unbrowse_search)"
else
  bad "B1: missing search surface (cli_search=$cli_search mcp_search=$mcp_search)"
fi
# B2: the Exa fallback pays Exa via x402 IN ONE MODULE (not API-key-only).
# Honest check: a single file calls api.exa.ai AND carries the x402 PAYMENT-SIGNATURE
# flow — co-located, not two unrelated files.
EXAMOD=src/search/exa-x402.ts
if [ -f "$EXAMOD" ] && grep -qE 'api\.exa\.ai' "$EXAMOD" && grep -qiE 'PAYMENT-SIGNATURE|wrapFetchWithPayment|settleViaFlex|payment-signature' "$EXAMOD"; then
  pass "B2: Exa search miss pays Exa via x402 ($EXAMOD signs the Exa request)"
else
  bad "B2: $EXAMOD missing — Exa fallback not yet x402-paid (the Exa /search call must sign an x402 payment)"
fi
# B3 + B4: a real unit test asserts search + Exa-x402 + 50/35/15 split.
TESTF=$(ls tests/exa-search-x402*.test.ts 2>/dev/null | head -1)
if [ -n "$TESTF" ] && bun test "$TESTF" >/tmp/exa-test.out 2>&1; then
  pass "B3+B4: $TESTF passes (search + Exa x402 + 50/35/15 split)"
else
  bad "B3+B4: no passing tests/exa-search-x402*.test.ts (split 50/35/15 asserted on the search path)"
fi

sec "C. BENCHMARKS — a probe for the search-on-top"
if ls bench/exa/search-on-top*.sh bench/exa/search_on_top* 2>/dev/null | head -1 >/dev/null 2>&1; then
  pass "C1: a benchmark probe for the Exa search-on-top exists"
else
  bad "C1: no benchmark probe for the search-on-top (bench/exa/search-on-top*)"
fi

sec "D. DOCS + WHITEPAPER — corrected, gated"
# D2: Exa paid-search documented in a dedicated PUBLIC doc (not docs/internal/).
DOC=docs/for-agents/search-on-top.md
if [ -f "$DOC" ] && grep -qiE 'exa' "$DOC" && grep -qiE 'x402|402' "$DOC" && grep -qiE 'split|50/35/15|faremeter' "$DOC"; then
  pass "D2: Exa paid search-on-top documented ($DOC: exa + x402 + split)"
else
  bad "D2: $DOC missing or incomplete (needs exa + x402 + split)"
fi
# D3: the paper-gate stays green (paper reflects code, no moat leak).
if [ -f scripts/paper-gate.sh ] && bash scripts/paper-gate.sh paper/internal-apis.tex >/tmp/paper-gate.out 2>&1; then
  pass "D3: paper-gate green (paper reflects code, no leak)"
else
  bad "D3: paper-gate red — see /tmp/paper-gate.out"
fi
# D4: bonding/slashing not over-claimed as [shipped].
if [ -f paper/anchors.tsv ] && grep -iE 'bond|slash' paper/anchors.tsv | grep -q 'shipped'; then
  bad "D4: anchors.tsv marks bonding/slashing [shipped] — they are reference-only (over-claim)"
else
  pass "D4: anchors.tsv does not over-claim bonding/slashing as shipped"
fi

echo
if [ "$fail" -eq 0 ]; then
  echo "GREEN — one SDK + Exa x402 search-on-top (50/35/15) shipped; benchmarks, docs & whitepaper reflect it."
  exit 0
else
  echo "RED — north star not yet settled (see FAILs above)."
  exit 1
fi
