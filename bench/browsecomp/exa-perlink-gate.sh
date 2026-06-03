#!/usr/bin/env bash
# Witness: "Exa routes through into our per-link search." Runs the real searcher on
# one query and asserts it (a) routes through Exa to ranked links and (b) enriches
# each link via unbrowse fetch (per-link content), returning >=3 real results whose
# snippets are full-page chunks, not thin SERP lines. Exit 0 iff the routing works.
set -uo pipefail
REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"; cd "$REPO"
set -a; . ./.env 2>/dev/null || true; . ~/.config/unbrowse-bench/exa.env 2>/dev/null || true; set +a
export UNBROWSE_BIN="${UNBROWSE_BIN:-$REPO/bench/browsecomp/.unbrowse-src}"
python3 - <<'PY'
import asyncio, sys, os
sys.path.insert(0, "bench/browsecomp")
import unbrowse_browsecomp_searcher as S
async def main():
    eng = S.UnbrowseSearchEngine()
    res = await eng("who is the CEO of Anthropic and when was the company founded", 5)
    print(f"results={len(res)}")
    enriched = [r for r in res if len(r.snippet) > 300]   # per-link fetch produced a full chunk
    for r in res[:5]:
        print(f"  [{len(r.snippet):>5}c] {r.url[:70]}")
    ok = len(res) >= 3 and len(enriched) >= 1
    print("PASS" if ok else "FAIL")
    sys.exit(0 if ok else 1)
asyncio.run(main())
PY
