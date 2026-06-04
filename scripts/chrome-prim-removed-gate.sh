#!/usr/bin/env bash
# Witness: the dead chrome-prim fork is gone and nothing depended on it.
# Exits 0 EXACTLY when: (1) src/chrome-prim absent, (2) zero references repo-wide,
# (3) the CLI entry still bundles (proves the import graph is intact without it).
set -uo pipefail
cd "$(dirname "$0")/.." || exit 2
fail=0

if [ -d src/chrome-prim ]; then echo "FAIL: src/chrome-prim still exists"; fail=1; else echo "ok   src/chrome-prim removed"; fi

# git grep = tracked files only (fast; never walks node_modules/.git/dist).
refs=$(git grep -l "chrome-prim" -- ':!scripts/chrome-prim-removed-gate.sh' ':!*.hallmark*' 2>/dev/null | wc -l | tr -d ' ')
if [ "$refs" != "0" ]; then echo "FAIL: $refs chrome-prim reference(s) remain"; git grep -n "chrome-prim" -- ':!scripts/chrome-prim-removed-gate.sh' | head; fail=1; else echo "ok   no chrome-prim references in tracked source"; fi

rm -rf /tmp/chrome-prim-gate-build
if bun build src/cli.ts --target=node --outdir=/tmp/chrome-prim-gate-build >/tmp/chrome-prim-gate-build.log 2>&1; then
  echo "ok   CLI entry bundles (import graph intact)"
else
  echo "FAIL: bun build src/cli.ts failed:"; tail -5 /tmp/chrome-prim-gate-build.log; fail=1
fi

[ "$fail" = "0" ] && echo "GATE GREEN" || echo "GATE RED"
exit $fail
