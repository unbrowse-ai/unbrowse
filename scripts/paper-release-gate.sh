#!/usr/bin/env bash
# paper-release-gate.sh — papers release ONE PER DAY, in Thanos stone-COLLECTION
# order (Power → Space → Reality → Soul → Time → Mind). This witness enforces:
#   1. ORDER is monotonic — no paper may be marked released/published before
#      every earlier-collected stone's paper is (no out-of-order drop);
#   2. READY — each scheduled paper's .tex exists AND passes paper-gate;
#   3. WELL-FORMED — ranks are contiguous 1..N, one row per day.
# Data lives in paper/release-order.tsv (pointer, not payload). The gate is the
# witness; it decides when a release is sound, not anyone's word.
#
#   bash scripts/paper-release-gate.sh
set -uo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"; cd "$ROOT"
TSV="paper/release-order.tsv"
fail=0
[ -f "$TSV" ] || { echo "release-gate: missing $TSV"; exit 2; }

echo "=== paper-release-gate: $TSV ==="
prev_rank=0
seen_pending=0
while IFS=$'\t' read -r rank stone basename date status; do
  [ -z "${rank:-}" ] && continue
  case "$rank" in \#*|rank) continue;; esac

  # 3. contiguous ranks
  if [ "$rank" -ne $((prev_rank + 1)) ]; then
    echo "  ORDER-FAIL: rank $rank not contiguous after $prev_rank"; fail=1
  fi
  prev_rank=$rank

  # 2. release-ready: paper exists + paper-gate green
  tex="paper/$basename.tex"
  if [ ! -f "$tex" ]; then
    echo "  READY-FAIL: rank $rank ($stone) $tex missing"; fail=1
  elif ! bash scripts/paper-gate.sh "$tex" >/dev/null 2>&1; then
    echo "  READY-FAIL: rank $rank ($stone) $basename fails paper-gate"; fail=1
  fi

  # 1. monotonic release: once a pending is seen, no later release is allowed
  case "$status" in
    released|published)
      if [ "$seen_pending" -eq 1 ]; then
        echo "  ORDER-FAIL: rank $rank ($stone) released before an earlier stone — out of collection order"; fail=1
      fi
      ;;
    pending) seen_pending=1 ;;
    *) echo "  STATUS-FAIL: rank $rank unknown status '$status'"; fail=1 ;;
  esac

  echo "  day $rank: $stone  $basename  ($date)  — $status"
done < "$TSV"

echo
if [ "$fail" -ne 0 ]; then
  echo "PAPER-RELEASE-GATE FAIL — order unsound or a scheduled paper is not gate-green."
  exit 1
fi
echo "PAPER-RELEASE-GATE PASS — $prev_rank papers, collection-order sound, every paper gate-green."
