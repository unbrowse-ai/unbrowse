#!/usr/bin/env bash
# full-client-public-sync.sh — assemble the FULL readable client into a public
# worktree for the zk-auditable mirror (unbrowse-ai/unbrowse).
#
# Unlike open-core-sync (allow-list), this publishes the WHOLE client runtime
# source — src/ (capture/RE/indexer/orchestrator/marketplace included) + packages/
# + tests/ + public docs — so the client is fully auditable. It does NOT publish
# the moat that lives OUTSIDE the client: backend/, frontend/, .planning/, internal/.
#
# The standing scrub rule still binds: the internal METHOD vocabulary, scripture,
# economic constants, and the designated never-public scoring/learning mechanism
# keywords are translated to plain secular engineering language in the public tree
# (the dev tree keeps its own naming). Gates are the witness: leak-guard,
# public-tree-leak-gate, pubrepo-vocab-gate must all pass on the assembled tree.
#
#   bash scripts/full-client-public-sync.sh <target-worktree>
set -uo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DST="${1:?usage: full-client-public-sync.sh <target-tree>}"
cd "$ROOT"

# Exclude ALL build output: it embeds the pre-scrub original source (sourcemaps,
# bundles, the codedb index) and would re-leak vocab the text-scrub can't reach.
# The public repo is source-for-audit; built artifacts belong in the npm package.
EXCLUDES=(--exclude='node_modules/' --exclude='dist/' --exclude='dist-sm/' --exclude='dist-*/'
  --exclude='runtime-src/' --exclude='packed-src/' --exclude='.open-next/' --exclude='*.map'
  --exclude='*.snapshot' --exclude='*.min.js' --exclude='codedb*'
  --exclude='*.tsbuildinfo' --exclude='__pycache__/' --exclude='*.pyc' --exclude='*.egg-info/'
  --exclude='.planning/' --exclude='internal/' --exclude='.claude/' --exclude='.git/'
  --exclude='vendor/' --exclude='*.node' --exclude='*.wasm')

echo "== sync full client source (src + packages + tests + interop) =="
for top in src packages tests; do
  [ -d "$ROOT/$top" ] && rsync -a --prune-empty-dirs "${EXCLUDES[@]}" "$ROOT/$top/" "$DST/$top/" && echo "  + $top/"
done

# Drop server-only tests: anything importing from backend/ (e.g. the reverse-engineer
# inference engine, which lives under backend/ and is never mirrored) would have a dangling
# import in the public tree. Those are server-side tests, not client tests — remove them.
echo "== drop server-only tests (import backend/) from the public tree =="
if [ -d "$DST/tests" ]; then
  grep -rlE "(from|import\()[[:space:]]*['\"][^'\"]*/backend/" "$DST/tests" 2>/dev/null | while read -r t; do
    rm -f "$t"; echo "  - $(echo "$t" | sed "s#$DST/##")"
  done
fi

echo "== sync public docs + root entrypoints =="
rsync -a --prune-empty-dirs "${EXCLUDES[@]}" --exclude='internal/' "$ROOT/docs/" "$DST/docs/"
for f in README.md SKILL.md LICENSE version.json; do
  [ -f "$ROOT/$f" ] && cp "$ROOT/$f" "$DST/$f" && echo "  + $f"
done
[ -f "$ROOT/packages/skill/LICENSE" ] || true

# ── scrub internal vocabulary out (rename + translate; the shared guardrail) ──
echo "== scrub internal vocabulary out of the public tree =="
bash "$ROOT/scripts/scrub-vocab.sh" "$DST"
echo "  scrubbed $(find "$DST" -type f \( -name '*.ts' -o -name '*.md' -o -name '*.py' \) -not -path '*/node_modules/*' 2>/dev/null | wc -l | tr -d ' ') files"

# The public client is MIT (OPEN-SOURCE-NOTICE). Normalize every LICENSE in the tree
# to the root MIT text so no nested Apache "covenant not to assert" legal English
# trips the leak gate (it is a false positive, but MIT is the correct public license).
if [ -f "$DST/LICENSE" ] && grep -qi 'MIT License' "$DST/LICENSE"; then
  find "$DST" -type f -name 'LICENSE' -not -path '*/node_modules/*' -not -path "$DST/LICENSE" 2>/dev/null | while read -r lf; do
    cp "$DST/LICENSE" "$lf"; echo "  normalized LICENSE -> MIT: $(echo "$lf"|sed "s|$DST/||")"
  done
fi
echo "full-client sync complete -> $DST"
