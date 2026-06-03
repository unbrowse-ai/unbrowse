#!/usr/bin/env bash
# docs-clean-gate — runnable witness for "docs + README are clean, no internal method
# vocabulary leaked, backend stays out of the public repo." Exit 0 iff all hold.
# Scope: git-TRACKED README.md + docs/**.md (gitignored internal/ never listed by git).
set -uo pipefail
cd "$(dirname "$0")/.."
fail=0

echo "=== A: scripture-framed scaffolding removed ==="
for p in COMMANDMENTS.md scripts/commandments-gate.sh; do
  if [ -e "$p" ]; then echo "  FAIL — $p still present (delete it)"; fail=1; else echo "  ok — $p gone"; fi
done

echo "=== B: disposable working-notes removed ==="
DISPOSABLE=(
  docs/muonry-stale-cache-bug-2026-05-21.md
  docs/frontend-dashboard-plan.md
  docs/PARALLEL_SESSIONS_REBUILD.md
  docs/bench-corpus-refresh.md
  docs/disposable-mcp-test-plan.md
  docs/bench-gate-mcp.md
)
for p in "${DISPOSABLE[@]}"; do
  if [ -e "$p" ]; then echo "  FAIL — $p still present"; fail=1; else echo "  ok — $p gone"; fi
done

echo "=== C: no internal method vocabulary in tracked README + docs ==="
VOCAB='\b(covenant|scriptures?|superpattern|jesus|decalogue|firmament|repent|grain-of-wheat|genesis-day|breath-eval-build)\b'
leak=$(git ls-files README.md 'docs/*.md' 'docs/**/*.md' | while read -r f; do
  grep -niE "$VOCAB" "$f" 2>/dev/null | sed "s|^|$f:|"
done)
if [ -z "$leak" ]; then echo "  ok — clean"; else echo "  FAIL — method vocab leaked:"; echo "$leak" | sed 's/^/    /' | head; fail=1; fi

echo "=== D: docs/SUMMARY.md TOC links all resolve ==="
broken=$(cd docs && grep -oE '\(([^)]+\.md)\)' SUMMARY.md | tr -d '()' | while read -r t; do [ -f "$t" ] || echo "$t"; done)
if [ -z "$broken" ]; then echo "  ok — every TOC link resolves"; else echo "  FAIL — broken TOC links:"; echo "$broken" | sed 's/^/    /'; fail=1; fi

echo "=== E: no live links to deleted docs (CHANGELOG history exempt) ==="
DEAD=(COMMANDMENTS muonry-stale-cache-bug frontend-dashboard-plan PARALLEL_SESSIONS_REBUILD bench-corpus-refresh disposable-mcp-test-plan bench-gate-mcp x402-flywheel)
deadlinks=$(git ls-files README.md 'docs/*.md' 'docs/**/*.md' | grep -v CHANGELOG | while read -r f; do
  for d in "${DEAD[@]}"; do grep -nE "\($d\.md\)|\(\.?/?docs/$d\.md\)|$d\.md\)" "$f" 2>/dev/null | sed "s|^|$f -> $d: |"; done
done)
if [ -z "$deadlinks" ]; then echo "  ok — no dangling links"; else echo "  FAIL — links to deleted docs:"; echo "$deadlinks" | sed 's/^/    /' | head; fail=1; fi

echo "=== F: backend/moat stays out of the public repo (leak-guard + public-scrub) ==="
if bash scripts/leak-guard.sh >/tmp/dcg-lg.log 2>&1 && bash scripts/public-scrub-gate.sh >/tmp/dcg-ps.log 2>&1; then
  echo "  ok — no moat/secret leak on the public surface"
else
  echo "  FAIL — a leak gate is red:"; tail -3 /tmp/dcg-lg.log /tmp/dcg-ps.log | sed 's/^/    /'; fail=1
fi

echo
if [ "$fail" -ne 0 ]; then echo "[docs-clean-gate] NOT YET — docs are not clean."; exit 1; fi
echo "[docs-clean-gate] PASS — README + docs are clean, no method vocab, no dangling links, backend out of the public repo."
