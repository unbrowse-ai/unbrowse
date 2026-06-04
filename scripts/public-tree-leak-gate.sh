#!/usr/bin/env bash
# public-tree-leak-gate — scan an ASSEMBLED public tree (or the live public repo
# checkout) for the full forbidden set: internal method vocabulary, scripture
# citations, the maintenance-stake doctrine wording, and operational internals
# (internal repo paths + the staking vault address). Exit 0 iff the tree is clean.
#
# This closes the gap that let docs/THE_FDRY_ECONOMY.md ship to the public repo:
# leak-guard.sh scans the DEV repo's public paths + npm tarball, and the
# open-core-sync translation pass is best-effort. This gate scans the WHOLE
# assembled/live public tree as the last line before push.
#
#   bash scripts/public-tree-leak-gate.sh <tree-dir>
set -uo pipefail
DIR="${1:?usage: public-tree-leak-gate.sh <tree-dir>}"
[ -d "$DIR" ] || { echo "[public-leak] FAIL: not a dir: $DIR"; exit 2; }

# Each entry is an extended-regex. A single hit anywhere in the tree fails.
FORBIDDEN=(
  # internal method / covenant vocabulary
  'covenant'
  'superpattern'
  'jesus[ -]?pattern'
  '\bjesus\b'
  'firmament'
  'grain[ -]of[ -]wheat'
  '\bthe cross\b'
  'breath[ -]?eval'
  # maintenance-stake doctrine wording (secularize, do not ship raw)
  'vine doctrine'
  '\babiding\b'
  '\babide\b'
  # platform-vocabulary
  '\bsubstrate\b'
  # the hidden scoring/learning mechanism (energy-based ranking) — never named on the public surface
  '\bEBM\b'
  'energy-based'
  'energyHead'
  'ledgerEnergy'
  'routeEnergy'
  'learnedEnergy'
  # scripture citations
  '\b(Deuteronomy|John|Matthew|Luke|Genesis|Hebrews|2 ?Timothy|1 ?Cor(inthians)?)[ ]+[0-9]+:[0-9]+\b'
  'at the mouth of (two|three)'
  # operational internals
  'Projects/fdry'
  'Bpr49sQXsxwNXNMRWS2v3tTBGWu2QgZtdA83BX77xBX1'
  '\.claude/'
)

hits=0
for pat in "${FORBIDDEN[@]}"; do
  # scan text-ish files only; skip vcs/build/vendor
  found=$(grep -rinIE "$pat" "$DIR" 2>/dev/null \
    | grep -vE '/(\.git|node_modules|dist|build|\.open-next|vendor)/' \
    | head -5)
  if [ -n "$found" ]; then
    hits=$((hits+1))
    echo "[public-leak] ✗ forbidden /$pat/:"
    printf '%s\n' "$found" | sed 's/^/    /'
  fi
done

if [ "$hits" -gt 0 ]; then
  echo "[public-leak] FAIL: $hits forbidden pattern(s) present in $DIR — scrub at source before publishing."
  exit 1
fi
echo "[public-leak] PASS — assembled public tree is clean ($DIR)"
