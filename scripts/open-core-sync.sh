#!/usr/bin/env bash
# open-core-sync.sh — assemble the public open-core tree (additive, allow-list).
#
# Copies ONLY the allow-listed public surface from the dev repo into a target tree
# (arg 1, a worktree checked out on the public default branch `main`). Additive on
# top of the already-clean public tree: source files only (no node_modules/dist/
# build), never the moat.
#
#   bash scripts/open-core-sync.sh /path/to/public-worktree
set -uo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DST="${1:?usage: open-core-sync.sh <target-tree>}"
cd "$ROOT"

# Public packages: every drop-in / agent-SDK / python adapter + the adopter.
# The SDK is now folded into the `unbrowse` npm package (import from `unbrowse/sdk`),
# so the standalone sdk / sdk-v2 packages are retired and no longer synced.
# NOT packages/skill (has moat src), NOT extraction-core (capture engine).
PUBLIC_PKGS=(adopt
  axios-shim got-shim ky-shim node-fetch-shim cross-fetch-shim undici-shim superagent-shim wretch-shim
  playwright-shim puppeteer-shim selenium-shim stagehand-shim
  firecrawl-shim exa-shim tavily-shim
  ai-sdk langchain-js mastra llamaindex openai-agents
  py-requests py-httpx py-aiohttp py-urllib3 py-crewai py-pydantic-ai)

copy() { # src-relpath
  local rel="$1"
  rsync -a --prune-empty-dirs \
    --exclude='node_modules/' --exclude='dist/' --exclude='build/' --exclude='.open-next/' \
    --exclude='*.tsbuildinfo' --exclude='__pycache__/' --exclude='*.pyc' --exclude='*.egg-info/' \
    "$ROOT/$rel" "$DST/$(dirname "$rel")/"
}

echo "== syncing $((${#PUBLIC_PKGS[@]})) public packages =="
mkdir -p "$DST/packages"
for p in "${PUBLIC_PKGS[@]}"; do
  [ -d "$ROOT/packages/$p" ] && copy "packages/$p" && echo "  + packages/$p"
done

echo "== syncing public developer docs =="
mkdir -p "$DST/docs/for-developers" "$DST/docs/for-agents"
for d in for-developers for-agents sdk whitepaper start-here public concepts guides; do
  [ -d "$ROOT/docs/$d" ] && rsync -a --exclude='internal/' "$ROOT/docs/$d/" "$DST/docs/$d/" && echo "  + docs/$d"
done
for f in OPEN-SOURCE-NOTICE.md README.md SECURITY.md vision.md HOW_UNBROWSE_PAYS.md THE_FDRY_ECONOMY.md wallets.md; do
  [ -f "$ROOT/docs/$f" ] && cp "$ROOT/docs/$f" "$DST/docs/$f" && echo "  + docs/$f"
done

echo "== refresh root README + interop (public) =="
[ -f "$ROOT/docs/OPEN-SOURCE-NOTICE.md" ] && cp "$ROOT/docs/OPEN-SOURCE-NOTICE.md" "$DST/docs/OPEN-SOURCE-NOTICE.md"
mkdir -p "$DST/src"; rsync -a --exclude='node_modules/' "$ROOT/src/interop/" "$DST/src/interop/"

# Root SKILL.md — the agentskills.io skill manifest so `npx skills add
# unbrowse-ai/unbrowse` resolves the unbrowse skill (instructions; the runtime
# binary + MCP come from the `unbrowse` npm package). Single source of truth in
# the dev root, public-safe (no moat), gated by open-core-gate + leak-guard.
[ -f "$ROOT/SKILL.md" ] && cp "$ROOT/SKILL.md" "$DST/SKILL.md" && echo "  + SKILL.md (root, for npx skills add)"

# --- translate internal vocabulary out of the public tree (jargon guardrail) ---
# The dev source may use internal naming in non-doc surfaces (e.g. src/interop
# imports a CovenantVerb type); the PUBLIC tree must read in plain secular
# engineering language. Translate every synced file in place. perl -i for
# portability (macOS/Linux). Idempotent on already-clean files. Crossmint and
# cross-* compounds are preserved (\b after "cross" never matches "Crossmint").
echo "== translate internal vocabulary out of the public tree =="
find "$DST" -type f \( -name '*.ts' -o -name '*.tsx' -o -name '*.js' -o -name '*.mjs' -o -name '*.md' -o -name '*.json' \) \
  -not -path '*/node_modules/*' -not -path '*/dist/*' -print0 2>/dev/null | while IFS= read -r -d '' f; do
  perl -0pi -e '
    s/COVENANT_MAP/ROUTE_MAP/g;
    s/CovenantVerb/Verb/g;
    s/covenant-mapping/verb-mapping/g;
    s/covenant-seed/route-seed/g;
    s/Covenant/Route/g;
    s/covenant/route/g;
    s/Superpattern/Architecture/g;
    s/superpattern/architecture/g;
    s/jesus[- ]?pattern/the method/gi;
    s/\bjesus\b/the method/gi;
    s{build \(commit\) / breath \(act\) / eval \(observe\)}{create / act / read}g;
    s/\bbreath\b/act/g;
    s/\bthe cross\b/the root signature/gi;
    s/\bfirmament\b/boundary/gi;
    s{grain[- ]of[- ]wheat}{seed}gi;
    s/\bsabbath\b/rest/gi;
    s/\bscripture\b/intent/gi;
    s/Scripture/Intent/g;
    s/\bcommandments?\b/invariant/gi;
    s/Genesis[ -][Dd]ay(s)?/phase$1/g;
    s/Genesis-days/phased/g;
    s{thou shalt not steal/DRY}{no-duplication/DRY}g;
    s/thou shalt not steal/no duplication/gi;
    s/two witnesses/two corroborations/gi;
    s{\.claude/[A-Za-z0-9_./\-]+}{(internal)}g;
    # platform-vocabulary + maintenance-stake-model secularization
    s/\bthe substrate\b/the platform/gi;
    s/\bsubstrate\b/platform/gi;
    s/Vine Doctrine/maintenance-stake model/gi;
    s/\babiding\b/staking/gi;
    s/\babide\b/stake/gi;
    # redact operational internals: internal repo paths + the staking vault PDA
    s{~?/?Projects/fdry[A-Za-z0-9_./\-]*}{(internal)}g;
    s/\bBpr49sQXsxwNXNMRWS2v3tTBGWu2QgZtdA83BX77xBX1\b/(vault address withheld)/g;
    # strip scripture citations (Book c:v) that may ride along in prose
    s/\s*\((?:Deuteronomy|John|Matthew|Luke|Genesis|Hebrews|1 ?Cor(?:inthians)?|2 ?Timothy)\s+\d+:\d+[^)]*\)//gi;
    s/\b(?:Deuteronomy|John|Matthew|Luke|Genesis|Hebrews|2 ?Timothy)\s+\d+:\d+\b//g;
  ' "$f"
done
echo "  translated $(find "$DST" -type f \( -name '*.ts' -o -name '*.md' \) -not -path '*/node_modules/*' 2>/dev/null | wc -l | tr -d ' ') files"

echo "open-core sync complete -> $DST"
