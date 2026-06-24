#!/usr/bin/env bash
# capability-backlog-gate.sh — validates docs/UNBROWSE-CAPABILITY-BACKLOG.md (jesus-loop).
# Green iff: the backlog exists, all 6 papers are referenced, all 7 north-star asks are covered in the
# index, and a sample of `shipped` code-anchors RESOLVE on disk (no-fake-green as a schema). Exit 0.
set -uo pipefail
ROOT="/Users/lekt9/Projects/unbrowse-ecosystem/unbrowse"
AIKO="/Users/lekt9/.claude/skills/contract"
BL="${BL:-$ROOT/docs/UNBROWSE-CAPABILITY-BACKLOG.md}"
fail=0
[ -f "$BL" ] || { echo "FAIL: no backlog at $BL"; exit 1; }

echo "── 1. each of the 6 papers referenced ──"
for p in the-margin internal-apis-are identity execute-dont-guess energy-route-ranking crypto; do
  if grep -q "$p" "$BL"; then echo "  ok   $p"; else echo "  FAIL $p not referenced"; fail=1; fi
done

echo "── 2. each of the 7 north-star asks covered in the index ──"
for a in "web2 API" "frontend" "UX" "emergentDB wraps IQ" "benchmarks" "production" "the rip"; do
  if grep -qi "$a" "$BL"; then echo "  ok   $a"; else echo "  FAIL ask '$a' not covered"; fail=1; fi
done

echo "── 3. EVERY 'shipped' row has >=1 RESOLVING backticked anchor (full no-fake-green firmament) ──"
# A row may claim `shipped` only if it EXHIBITS PROOF THAT RESOLVES: at least one backticked anchor
# token that exists on disk — as a path under the repo or aiko substrate, or by basename under src/
# or libcontract/zig src. This single rule catches all fake-green vectors at once: an empty anchor
# cell, an unquoted anchor, a non-existent file, OR a backticked token that names nothing real.
# (Paper-anchors like release-order.tsv stay plain text, so they are not mistaken for code anchors.)
miss=0
while IFS= read -r row; do
  resolved=0
  for tok in $(printf '%s' "$row" | grep -oE '`[^`]+`' | tr -d '`' | sed 's/:.*//'); do
    base="$(basename "$tok")"
    if [ -e "$ROOT/$tok" ] || [ -e "$AIKO/$tok" ] \
       || [ -f "$AIKO/libcontract/src/$base" ] || [ -f "$AIKO/zig/src/$base" ] \
       || find "$ROOT/src" -name "$base" -print -quit 2>/dev/null | grep -q .; then
      resolved=1; break
    fi
  done
  if [ "$resolved" -eq 0 ]; then
    echo "  FAIL no resolving anchor:$(printf '%s' "$row" | cut -c1-60)"; miss=$((miss+1))
  fi
done < <(grep '| shipped |' "$BL")
[ "$miss" -eq 0 ] && echo "  ok   every shipped row has a resolving backticked anchor"
[ "$miss" -gt 0 ] && fail=1

if [ "$fail" -eq 0 ]; then
  echo "── BACKLOG GREEN — 6 papers + 7 asks covered, shipped anchors resolve ──"; exit 0
fi
echo "── BACKLOG NOT SETTLED ──"; exit 1
