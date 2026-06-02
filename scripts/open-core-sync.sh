#!/usr/bin/env bash
# open-core-sync.sh — assemble the public open-core tree (additive, allow-list).
#
# Copies ONLY the allow-listed public surface from the dev repo into a target tree
# (arg 1, a worktree checked out on open-core). Additive on top of the already-clean
# open-core branch: source files only (no node_modules/dist/build), never the moat.
#
#   bash scripts/open-core-sync.sh /path/to/open-core-worktree
set -uo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DST="${1:?usage: open-core-sync.sh <target-tree>}"
cd "$ROOT"

# Public packages: the open SDKs + every drop-in / agent-SDK / python adapter + the
# adopter. NOT packages/skill (has moat src), NOT extraction-core (capture engine).
PUBLIC_PKGS=(sdk sdk-v2 adopt
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
for d in for-developers for-agents sdk whitepaper start-here public concepts; do
  [ -d "$ROOT/docs/$d" ] && rsync -a --exclude='internal/' "$ROOT/docs/$d/" "$DST/docs/$d/" && echo "  + docs/$d"
done
for f in OPEN-SOURCE-NOTICE.md README.md SECURITY.md vision.md HOW_UNBROWSE_PAYS.md THE_FDRY_ECONOMY.md; do
  [ -f "$ROOT/docs/$f" ] && cp "$ROOT/docs/$f" "$DST/docs/$f" && echo "  + docs/$f"
done

echo "== refresh root README + interop (public) =="
[ -f "$ROOT/docs/OPEN-SOURCE-NOTICE.md" ] && cp "$ROOT/docs/OPEN-SOURCE-NOTICE.md" "$DST/docs/OPEN-SOURCE-NOTICE.md"
mkdir -p "$DST/src"; rsync -a --exclude='node_modules/' "$ROOT/src/interop/" "$DST/src/interop/"

echo "open-core sync complete -> $DST"
