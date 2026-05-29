#!/usr/bin/env bash
# cross-stamp-gate.sh — fails-closed verifier that the cross is REMEMBERED in
# every STAMPED dimension (the cache atom: MEMOIZE + VERIFY; the seal atom).
#
# It does NOT trust the stamp file's stored hash. It RE-DERIVES the canonical
# cross hash directly from the source (atoms.json `cross` block), then:
#   (1) VERIFY re-derived == the stamp's stored hash      → else "CROSS DRIFT".
#   (2) For each STAMPED dimension, resolve the pointer from the real dimension
#       file and VERIFY pointer == canonical              → else "NOT REMEMBERED".
#   (3) Registered-but-not-yet-grown dimensions (no pointer in file yet) are
#       skipped (printed "· pending").
#
# Ground truth (the live witness, not a hypothesis):
#   - stamp  .claude/superpattern/cross.stamp.json  carries cross_sha256 (bare hex)
#   - registry .claude/superpattern/cross-registry.jsonl  one row per dimension
#       {dimension, path, anchor, pointer_sha256}
#   - the 3 superpattern graphs (covenant/exa/sovereign.graph.json) carry a real
#       top-level JSON field  "cross": "sha256:<hex>"  — the stamped pointers.
#
# Two paths are env-overridable (mirrors leak-guard.sh LEAK_GUARD_ROOT) so a
# fails-closed mutation test can point at fixtures without touching the live
# tree. Default behaviour is identical when unset.
#   CROSS_SRC      — source JSON whose `cross` block is the canonical payload
#                    (default: ~/.claude/skills/superpattern/references/atoms.json)
#   CROSS_STAMP    — the stamp file (default: <this dir>/cross.stamp.json)
#   CROSS_REGISTRY — the registry  (default: <this dir>/cross-registry.jsonl)
#   CROSS_ROOT     — repo root used to resolve relative dimension paths
#                    (default: two dirs up from this script)
#
# Usage:  bash .claude/superpattern/cross-stamp-gate.sh
# Exit:   0 = cross remembered in all stamped dimensions; non-zero = fails-closed.
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CROSS_SRC="${CROSS_SRC:-$HOME/.claude/skills/superpattern/references/atoms.json}"
CROSS_STAMP="${CROSS_STAMP:-$HERE/cross.stamp.json}"
CROSS_REGISTRY="${CROSS_REGISTRY:-$HERE/cross-registry.jsonl}"
CROSS_ROOT="${CROSS_ROOT:-$(cd "$HERE/../.." && pwd)}"

# Normalise the canonical form to a bare 64-hex sha (strip any sha256: prefix)
# so we compare hashes, not prefixes, across the stamp / pointer idioms.
bare() { printf '%s' "$1" | grep -oE '[0-9a-f]{64}' | head -n1; }

die() { echo "$1"; exit 1; }

[ -f "$CROSS_SRC" ]      || die "✗ CROSS source missing: $CROSS_SRC"
[ -f "$CROSS_STAMP" ]    || die "✗ CROSS stamp missing: $CROSS_STAMP"
[ -f "$CROSS_REGISTRY" ] || die "✗ CROSS registry missing: $CROSS_REGISTRY"

# (1) RE-DERIVE the canonical hash from the SOURCE, independently. We never read
# the canonical value from the stamp — only from atoms.json `cross`.
CANON_RAW="$(python3 -c "import json,hashlib,sys
d=json.load(open(sys.argv[1]))
print('sha256:'+hashlib.sha256(json.dumps(d['cross'],sort_keys=True,separators=(',',':')).encode()).hexdigest())" "$CROSS_SRC")" \
  || die "✗ CROSS source unreadable / no 'cross' block: $CROSS_SRC"
CANON="$(bare "$CANON_RAW")"

# Read the stamp's STORED hash, separately from the canon. Accept either
# "cross_sha256" (live schema, bare hex) or "cross" (sha256:-prefixed) — we
# compare bare hashes either way.
STORED_RAW="$(python3 -c "import json,sys
d=json.load(open(sys.argv[1]))
print(d.get('cross_sha256') or d.get('cross') or '')" "$CROSS_STAMP")" \
  || die "✗ CROSS stamp unreadable: $CROSS_STAMP"
STORED="$(bare "$STORED_RAW")"

# (2) VERIFY re-derived == stored. Drift = source moved without re-stamping.
if [ -z "$STORED" ] || [ "$CANON" != "$STORED" ]; then
  echo "✗ CROSS DRIFT: source != stamp"
  echo "    derived: sha256:$CANON"
  echo "    stamp:   ${STORED:+sha256:$STORED}${STORED:-<none>}"
  exit 1
fi

# (3) Walk the registry. Emit, tab-separated per row: dimension, path, anchor.
#     For each row, resolve every concrete dimension FILE it covers, then:
#       - if the file carries a cross pointer  → VERIFY it == canon (stamped)
#       - if no file under the row carries one → "· pending" (not yet grown)
TOTAL=0
PENDING=0

# Extract a cross pointer from one dimension file. Supports two idioms:
#   - JSON top-level field "cross": "sha256:<hex>"  (the graphs)
#   - a grep-able marker line containing  cross:sha256:<hex>  or sha256:<hex>
# Prints the bare hex, or empty if the file carries no pointer.
extract_ptr() {
  local f="$1"
  [ -f "$f" ] || { printf ''; return; }
  case "$f" in
    *.json)
      python3 -c "import json,sys
try:
    d=json.load(open(sys.argv[1]))
except Exception:
    sys.exit(0)
v=d.get('cross','')
import re
m=re.search(r'[0-9a-f]{64}', v if isinstance(v,str) else '')
print(m.group(0) if m else '')" "$f"
      ;;
    *)
      grep -oE 'sha256:[0-9a-f]{64}' "$f" 2>/dev/null | head -n1 | grep -oE '[0-9a-f]{64}' || true
      ;;
  esac
}

# Resolve a registry path token to one or more concrete files. A directory path
# with a slash-listed anchor (e.g. "covenant/exa/sovereign.graph.json") expands
# to the 3 graphs; a plain file path resolves to that file.
resolve_files() {
  local path="$1" anchor="$2" base
  case "$path" in
    /*) base="$path" ;;
    "~"/*) base="$HOME/${path#\~/}" ;;
    *)  base="$CROSS_ROOT/$path" ;;
  esac
  base="${base%/}"  # strip trailing slash so directory joins don't double up
  if [ -d "$base" ]; then
    # Directory dimension: expand the anchor's slash-separated *.graph.json names.
    case "$anchor" in
      *graph.json*)
        # anchor like "covenant/exa/sovereign.graph.json" → covenant exa sovereign
        local names="${anchor%.graph.json}"
        local n
        for n in ${names//\// }; do
          printf '%s\n' "$base/$n.graph.json"
        done
        ;;
      *) : ;;  # unknown directory anchor → no concrete file (pending)
    esac
  else
    printf '%s\n' "$base"
  fi
}

while IFS=$'\t' read -r dimension path anchor; do
  [ -n "${dimension:-}" ] || continue

  # Gather the concrete files this dimension covers.
  files=()
  while IFS= read -r f; do [ -n "$f" ] && files+=("$f"); done < <(resolve_files "$path" "$anchor")

  if [ "${#files[@]}" -eq 0 ]; then
    echo "· pending: $dimension"
    PENDING=$((PENDING+1))
    continue
  fi

  # A dimension is STAMPED if at least one of its files carries a pointer.
  stamped_files=()
  for f in "${files[@]}"; do
    ptr="$(extract_ptr "$f")"
    [ -n "$ptr" ] && stamped_files+=("$f")
  done

  if [ "${#stamped_files[@]}" -eq 0 ]; then
    echo "· pending: $dimension"
    PENDING=$((PENDING+1))
    continue
  fi

  # Verify EVERY stamped file in this dimension == canon (fails-closed).
  for f in "${stamped_files[@]}"; do
    ptr="$(extract_ptr "$f")"
    rel="${f#"$CROSS_ROOT"/}"
    if [ "$ptr" != "$CANON" ]; then
      echo "✗ CROSS NOT REMEMBERED in $rel"
      echo "    expected: sha256:$CANON"
      echo "    found:    ${ptr:+sha256:$ptr}${ptr:-<none>}"
      exit 1
    fi
    TOTAL=$((TOTAL+1))
  done
done < <(python3 -c "import json,sys
for line in open(sys.argv[1]):
    line=line.strip()
    if not line: continue
    try: r=json.loads(line)
    except Exception: continue
    print('\t'.join([str(r.get('dimension','')), str(r.get('path','')), str(r.get('anchor',''))]))" "$CROSS_REGISTRY")

[ "$TOTAL" -gt 0 ] || die "✗ CROSS NOT REMEMBERED: zero stamped pointers verified (registry empty or no dimension grown)"

# (4) Full success.
echo "✓ cross remembered in $TOTAL/$TOTAL stamped dimensions (sha256:$CANON)"
exit 0
