#!/usr/bin/env bash
# open-core-gate.sh — the public open-core tree shows the wedge and hides the moat.
#
# Verifies a candidate public tree (arg 1, default cwd) is BOTH:
#   WEDGE-COMPLETE — the open drop-in surface is all there: both SDKs, every
#     @unbrowse/* + unbrowse-* adapter, the interop standards layer, public docs,
#     README + LICENSE.
#   MOAT-FREE — none of the closed surface leaks: no backend/ internal/ bench/, src/
#     contains ONLY the public interop layer, no held-paper reference code
#     (Paper 2 zk-auth / Paper 3 maintenance are staged-reveal, not open-core), and
#     no sensitive capture/RE keyword anywhere in the tree.
#
# Exit 0 iff both. This is the seal before any push to the public repo — sp-opencore
# (open the surface, hide the engine); no string fakes it, it greps the real tree.
set -uo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
TREE="${1:-.}"
cd "$TREE"
fail=0
section() { echo; echo "=== $1 ==="; }

section "WEDGE-COMPLETE — the open drop-in surface is present"
need_dirs=(packages/sdk packages/sdk-v2 src/interop docs)
need_files=(README.md LICENSE docs/OPEN-SOURCE-NOTICE.md)
for d in "${need_dirs[@]}"; do [ -d "$d" ] && echo "  ok dir: $d" || { echo "  MISSING dir: $d"; fail=1; }; done
for f in "${need_files[@]}"; do [ -f "$f" ] && echo "  ok file: $f" || { echo "  MISSING file: $f"; fail=1; }; done
# adapter coverage: count @unbrowse/* shims+sdks + unbrowse-* python
adapters=$(find packages -maxdepth 2 -name package.json 2>/dev/null | wc -l | tr -d ' ')
pyadapters=$(find packages -maxdepth 2 -name pyproject.toml 2>/dev/null | wc -l | tr -d ' ')
echo "  adapters: $adapters npm package(s), $pyadapters python package(s)"
[ "$adapters" -ge 23 ] || { echo "  WEDGE-FAIL: expected >=23 npm packages (SDKs + ~21 adapters)"; fail=1; }
[ "$pyadapters" -ge 6 ] || { echo "  WEDGE-FAIL: expected >=6 python packages"; fail=1; }

section "MOAT-FREE — the closed surface is absent"
for d in backend internal bench; do [ -d "$d" ] && { echo "  MOAT-LEAK: $d/ present"; fail=1; } || echo "  absent: $d/"; done
# src/ must contain only interop
if [ -d src ]; then
  stray=$(find src -mindepth 1 -maxdepth 1 -not -name interop 2>/dev/null)
  [ -n "$stray" ] && { echo "  MOAT-LEAK: src/ has non-interop:"; echo "$stray" | sed 's/^/    /'; fail=1; } || echo "  src/: only interop/"
fi
# held-paper reference code must NOT be on open-core (staged reveal)
for h in paper/reference/zk paper/reference/layers paper/reference/network paper/reference/ledger/sealed_cache.py paper/reference/ledger/checkpoint.py; do
  [ -e "$h" ] && { echo "  STAGED-LEAK: held reference present: $h"; fail=1; } || true
done
echo "  staged-reveal: no held Paper 2/3 reference code"
# CANONICAL moat-term scan: use leak-guard.sh's own terms (uppercase economic
# constants + secrets + internal tooling names), NOT an invented list — the public
# thesis (reverse-engineering, JA3/JA4, curl-impersonate) is allowed; only the HOW
# (economic constants, sponsor secrets, internal harness names) is moat.
LG="$SCRIPT_DIR/leak-guard.sh"
LEAK=0
if [ -f "$LG" ]; then
  terms=$( { grep -oE '"[A-Z_]{6,}"' "$LG"; grep -oE '"[a-z][a-z0-9-]{5,}"' "$LG" | grep -E 'harness|dogfood|primitive-registry|leak-guard|integrity|visibility'; } | tr -d '"' | sort -u )
  for t in $terms; do
    hit=$(grep -rilF "$t" . --exclude-dir=node_modules --exclude-dir=dist --exclude-dir=.git 2>/dev/null | head -1 || true)
    [ -n "$hit" ] && { echo "  MOAT-TERM-LEAK: '$t' in $hit"; LEAK=$((LEAK+1)); }
  done
  echo "  scanned $(echo "$terms" | wc -w | tr -d ' ') canonical moat term(s)"
else
  echo "  WARN: leak-guard.sh not found at $LG — keyword scan skipped"; fail=1
fi
[ "$LEAK" -eq 0 ] && echo "  moat-term scan: clean" || fail=1

echo
if [ "$fail" -ne 0 ]; then echo "OPEN-CORE-GATE FAIL — the public tree is incomplete or leaks the moat."; exit 1; fi
echo "OPEN-CORE-GATE PASS — public tree shows the full wedge and hides the moat; safe to be the open-core branch."
