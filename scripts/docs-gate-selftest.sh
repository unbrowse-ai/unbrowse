#!/usr/bin/env bash
# docs-gate-selftest.sh — prove the docs gate has TEETH (Matt 7:24-25: test the
# foundation before the storm). A gate that cannot fail is a painted green.
#
# Three falsifiable signs:
#   1. docs-anchor-check FAILS when a doc cites a missing code path.
#   2. leak-guard       FAILS when a public doc carries a forbidden term.
#   3. the real docs gate PASSES on the live tree.
#
# Exit 0 only if all three hold. Uses temp dirs / a probe doc and cleans up;
# never mutates a tracked doc. Usage: bash scripts/docs-gate-selftest.sh
set -uo pipefail
ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

pass=0; fail=0
ok()   { echo "  ✓ $1"; pass=$((pass+1)); }
bad()  { echo "  ✗ $1" >&2; fail=$((fail+1)); }

TMP="$(mktemp -d)"
PROBE="docs/.gate-selftest-probe.md"
cleanup() { rm -f "$PROBE"; rm -rf "$TMP"; }
trap cleanup EXIT

echo "── sign 1: anchor-check must go RED on a missing path ─────────"
# A probe doc citing a path that cannot exist.
printf '# probe\n\nThis cites `src/__does_not_exist__/nope.ts` deliberately.\n' > "$PROBE"
if DOCS_ANCHOR_TARGETS="$PROBE" bash scripts/docs-anchor-check.sh >/dev/null 2>&1; then
  bad "anchor-check PASSED on a missing path — it has no teeth"
else
  ok  "anchor-check correctly failed on a missing path"
fi
rm -f "$PROBE"

echo "── sign 2: leak-guard must go RED on a forbidden term ─────────"
# A fake repo root with a docs/ carrying a forbidden vocabulary word. Abort on
# any setup failure so sign-2 can never pass vacuously (a half-built temp dir
# would make leak-guard "find no leak" because the probe was never written).
mkdir -p "$TMP/docs" "$TMP/scripts" "$TMP/packages/skill" || { bad "sign-2 setup mkdir failed"; exit 1; }
cp scripts/leak-guard.sh "$TMP/scripts/leak-guard.sh" || { bad "sign-2 setup cp failed"; exit 1; }
printf '# leak probe\n\nThis public doc mentions the word covenant on purpose.\n' > "$TMP/docs/leak-probe.md" || { bad "sign-2 probe write failed"; exit 1; }
# package.json shim so npm pack step in leak-guard does not abort the run.
printf '{"name":"probe","version":"0.0.0"}\n' > "$TMP/packages/skill/package.json" || { bad "sign-2 shim write failed"; exit 1; }
if LEAK_GUARD_ROOT="$TMP" bash "$TMP/scripts/leak-guard.sh" >/dev/null 2>&1; then
  bad "leak-guard PASSED with a forbidden term present — it has no teeth"
else
  ok  "leak-guard correctly failed on a forbidden term"
fi

echo "── sign 3: the real gate must be GREEN on the live tree ───────"
if bash scripts/docs-gate.sh >/dev/null 2>&1; then
  ok  "real docs-gate passes on the live tree"
else
  bad "real docs-gate FAILED on the live tree"
fi

echo ""
if [ "$fail" -eq 0 ]; then
  echo "[docs-gate-selftest] ✓ all 3 signs hold — the gate has teeth and the tree stands ($pass/3)"
  exit 0
else
  echo "[docs-gate-selftest] ✗ $fail of 3 signs failed — the gate is not trustworthy"
  exit 1
fi
