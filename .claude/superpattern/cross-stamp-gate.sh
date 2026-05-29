#!/usr/bin/env bash
# cross-stamp-gate.sh — fails-closed verifier that the cross is REMEMBERED in
# every STAMPED dimension (the cache atom: MEMOIZE + VERIFY; the seal atom).
#
# It does NOT trust the stamp file's stored hash. It RE-DERIVES the canonical
# cross hash directly from the source (atoms.json `cross` block), then:
#   (1) VERIFY re-derived == the stamp's stored "cross"  → else "CROSS DRIFT".
#   (2) For each dimension with stamped:true, resolve its pointer from the real
#       dimension file and VERIFY pointer == canonical → else "NOT REMEMBERED".
#   (3) stamped:false dimensions are skipped (printed "· pending").
#
# Two paths are env-overridable (mirrors leak-guard.sh LEAK_GUARD_ROOT) so a
# fails-closed mutation test can point at fixtures without touching the live
# tree. Default behaviour is identical when unset.
#   CROSS_SRC    — source JSON whose `cross` block is the canonical payload
#                  (default: ~/.claude/skills/superpattern/references/atoms.json)
#   CROSS_STAMP  — the stamp file
#                  (default: <this dir>/cross.stamp.json)
#
# Usage:  bash .claude/superpattern/cross-stamp-gate.sh
# Exit:   0 = cross remembered in all stamped dimensions; non-zero = fails-closed.
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CROSS_SRC="${CROSS_SRC:-$HOME/.claude/skills/superpattern/references/atoms.json}"
CROSS_STAMP="${CROSS_STAMP:-$HERE/cross.stamp.json}"

# Dimension paths in the stamp are stored repo-relative; resolve them against
# the repo root (two up from this script) unless absolute.
REPO_ROOT="$(cd "$HERE/../.." && pwd)"

die() { echo "$1"; exit 1; }

[ -f "$CROSS_SRC" ]   || die "✗ CROSS source missing: $CROSS_SRC"
[ -f "$CROSS_STAMP" ] || die "✗ CROSS stamp missing: $CROSS_STAMP"

# (1) RE-DERIVE the canonical hash from the SOURCE, independently. We never read
# the canonical value from the stamp — only from atoms.json `cross`.
CANON="$(python3 -c "import json,hashlib,sys
d=json.load(open(sys.argv[1]))
print('sha256:'+hashlib.sha256(json.dumps(d['cross'],sort_keys=True,separators=(',',':')).encode()).hexdigest())" "$CROSS_SRC")" \
  || die "✗ CROSS source unreadable / no 'cross' block: $CROSS_SRC"

# Read the stamp's STORED hash (top-level "cross") — separately from the canon.
STORED="$(python3 -c "import json,sys
d=json.load(open(sys.argv[1]))
print(d.get('cross',''))" "$CROSS_STAMP")" \
  || die "✗ CROSS stamp unreadable: $CROSS_STAMP"

# (2) VERIFY re-derived == stored. Drift = source moved without re-stamping.
if [ "$CANON" != "$STORED" ]; then
  echo "✗ CROSS DRIFT: source != stamp"
  echo "    derived: $CANON"
  echo "    stamp:   $STORED"
  exit 1
fi

# (3) Walk the stamped dimensions. The stamp emits, one per line:
#   <stamped(0|1)>\t<plane>\t<path>\t<key|->\t<marker|->
# pointer_key dimensions carry "<key>\t-"; pointer_marker carry "-\t<marker>".
TOTAL=0
PENDING=0
while IFS=$'\t' read -r stamped plane path pkey pmarker; do
  [ -n "${stamped:-}" ] || continue

  if [ "$stamped" != "1" ]; then
    echo "· pending: $plane"
    PENDING=$((PENDING+1))
    continue
  fi

  TOTAL=$((TOTAL+1))

  # Resolve dimension path (absolute as-is, else relative to repo root).
  case "$path" in
    /*) dpath="$path" ;;
    *)  dpath="$REPO_ROOT/$path" ;;
  esac
  [ -f "$dpath" ] || { echo "✗ CROSS NOT REMEMBERED in $path"; echo "    (file missing)"; exit 1; }

  if [ -n "$pkey" ] && [ "$pkey" != "-" ]; then
    # pointer_key: top-level JSON field named <pkey> == canonical hash.
    PTR="$(python3 -c "import json,sys
d=json.load(open(sys.argv[1]))
print(d.get(sys.argv[2],''))" "$dpath" "$pkey" 2>/dev/null || true)"
  elif [ -n "$pmarker" ] && [ "$pmarker" != "-" ]; then
    # pointer_marker: a grep-able marker line; the hash is the sha256:... token.
    line="$(grep -F "$pmarker" "$dpath" 2>/dev/null | head -n1 || true)"
    PTR="$(printf '%s\n' "$line" | grep -oE 'sha256:[0-9a-f]{64}' | head -n1 || true)"
  else
    echo "✗ CROSS NOT REMEMBERED in $path"
    echo "    (stamped dimension has no pointer_key or pointer_marker)"
    exit 1
  fi

  if [ "$PTR" != "$CANON" ]; then
    echo "✗ CROSS NOT REMEMBERED in $path"
    echo "    expected: $CANON"
    echo "    found:    ${PTR:-<none>}"
    exit 1
  fi
done < <(python3 -c "import json,sys
d=json.load(open(sys.argv[1]))
for dim in d.get('dimensions',[]):
    st='1' if dim.get('stamped') else '0'
    print('\t'.join([
        st,
        str(dim.get('plane','')),
        str(dim.get('path','')),
        str(dim.get('pointer_key','-') or '-'),
        str(dim.get('pointer_marker','-') or '-'),
    ]))" "$CROSS_STAMP")

# (4) Full success.
echo "✓ cross remembered in $TOTAL/$TOTAL stamped dimensions ($CANON)"
exit 0
