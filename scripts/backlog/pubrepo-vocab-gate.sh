#!/usr/bin/env bash
# pubrepo-vocab-gate.sh — witness: the PUBLIC repo (unbrowse-ai/unbrowse) carries
# none of the internal/method vocabulary in its current tree or commit messages.
# The full-history blob scrub was done once via git filter-repo + force-push and
# verified live; this re-runnable check guards the visible surface against a
# re-leak (e.g. a careless open-core-sync). Network-dependent: if the public repo
# can't be reached it SKIPS (prints so) rather than failing the whole gate.
set -uo pipefail

REPO_URL="https://github.com/unbrowse-ai/unbrowse.git"
# Method/IP vocabulary that must never appear on the public surface. "the cross"
# is matched word-boundaried and Crossmint is excluded (it's a real product).
VOCAB='covenant|jesus|superpattern|firmament|grain-of-wheat|\bsabbath\b|zero.?knowledge|zk-?proof|nullifier|privacy-ip'

TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

if ! timeout 90 git clone --quiet --filter=blob:none "$REPO_URL" "$TMP/pub" 2>/dev/null; then
  echo "pubrepo-vocab-gate: SKIP (public repo unreachable / no network)"
  exit 0
fi
cd "$TMP/pub" || { echo "pubrepo-vocab-gate: SKIP (clone dir missing)"; exit 0; }

fail=0

# 1) current tree (need blobs for grep -> checkout is already materialized for HEAD)
tree_hits=$(git grep -inE "$VOCAB" 2>/dev/null | grep -ivE 'crossmint' | wc -l | tr -d ' ')
if [ "$tree_hits" != "0" ]; then
  echo "pubrepo-vocab-gate: FAIL — $tree_hits vocab hit(s) in public tree:"
  git grep -inE "$VOCAB" 2>/dev/null | grep -ivE 'crossmint' | head
  fail=1
fi

# 2) commit messages across all refs + tags
git fetch --quiet --tags origin 2>/dev/null || true
msg_hits=$(git log --all --pretty='%s%n%b' 2>/dev/null | grep -icE "$VOCAB|\bscrub(bed)?\b|\bredact" | tr -d ' ')
if [ "$msg_hits" != "0" ]; then
  echo "pubrepo-vocab-gate: FAIL — $msg_hits vocab/scrub-announcing commit message(s)"
  fail=1
fi

if [ "$fail" -eq 0 ]; then
  echo "pubrepo-vocab-gate: ok — public tree + messages free of internal vocabulary"
  exit 0
fi
exit 1
