#!/usr/bin/env bash
# capability-backlog-gate.sh — validates docs/UNBROWSE-CAPABILITY-BACKLOG.md (jesus-loop).
# Green iff: the backlog exists, all 6 papers are referenced, all 7 north-star asks are covered in the
# index, and a sample of `shipped` code-anchors RESOLVE on disk (no-fake-green as a schema). Exit 0.
set -uo pipefail
ROOT="/Users/lekt9/Projects/unbrowse-ecosystem/unbrowse"
AIKO="/Users/lekt9/.claude/skills/contract"
BL="$ROOT/docs/UNBROWSE-CAPABILITY-BACKLOG.md"
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

echo "── 3. EVERY 'shipped' row's code-anchor RESOLVES (full no-fake-green firmament) ──"
# extract every .zig/.ts file path from `shipped` rows; each must resolve in the aiko substrate
# (libcontract/src or zig/src, by basename) OR the unbrowse repo (by given path or basename under src/).
miss=0
# code-anchors are BACKTICKED (`file.zig:sym`); paper-anchors like release-order.tsv are plain text
# (and would false-match `.ts` inside `.tsv`) — so extract only from backticked tokens.
for f in $(grep '| shipped |' "$BL" | grep -oE '`[^`]+`' | tr -d '`' | grep -oE '[A-Za-z0-9._/-]+\.(zig|ts)' | sort -u); do
  base="$(basename "$f")"
  if [ -f "$AIKO/libcontract/src/$base" ] || [ -f "$AIKO/zig/src/$base" ] || [ -f "$ROOT/$f" ] \
     || find "$ROOT/src" -name "$base" -print -quit 2>/dev/null | grep -q .; then
    echo "  ok   $f"
  else
    echo "  FAIL unresolved shipped anchor: $f"; miss=$((miss+1))
  fi
done
[ "$miss" -gt 0 ] && fail=1

echo "── 3b. EVERY 'shipped' row SHOWS a backticked anchor (no empty/unquoted-anchor fake-green) ──"
# A row may claim `shipped` only if it exhibits its proof: at least one backticked anchor token.
# Catches the fake-green vector where a row asserts shipped with an empty or unquoted anchor cell.
noanchor=0
while IFS= read -r row; do
  if echo "$row" | grep -qE '`[^`]+`'; then
    :
  else
    echo "  FAIL shipped row shows no backticked anchor:$(echo "$row" | cut -c1-64)"; noanchor=$((noanchor+1))
  fi
done < <(grep '| shipped |' "$BL")
[ "$noanchor" -eq 0 ] && echo "  ok   every shipped row exhibits a backticked anchor"
[ "$noanchor" -gt 0 ] && fail=1

if [ "$fail" -eq 0 ]; then
  echo "── BACKLOG GREEN — 6 papers + 7 asks covered, shipped anchors resolve ──"; exit 0
fi
echo "── BACKLOG NOT SETTLED ──"; exit 1
