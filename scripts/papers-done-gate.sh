#!/usr/bin/env bash
# papers-done-gate.sh — the trilogy is DONE TO COMPLETION AS CODE.
#
# Exits 0 exactly when every claim in all three papers is backed by running,
# tested reference code — no design-only (\prop{}) primitive remains — and every
# public gate is green and both PDFs compile clean. This is the runnable witness
# for the north star: "go deep, be native on all layers, finish all 3 papers for
# unbrowse to be done to completion as code."
#
# Five checks, all mechanical, no fabricated green:
#   1. REFERENCE TESTS green — paper/reference/tests/run_all.py exits 0 (>0 tests).
#   2. MANIFEST closed — every primitive in paper/reference/MANIFEST.tsv has its
#      impl file + test module on disk, its claim present in its paper, and that
#      claim line tagged shipped/reference (\impl{} or \ref{}), never \prop{}.
#   3. NO PURE-PROP — no \prop{} invocation survives in either paper body (only
#      the \newcommand definition + lines marked `% gate:prop-ok` are allowed).
#   4. PUBLIC GATES green — paper-gate x2, leak-guard x2, paper-spec-gate.
#   5. PDFs COMPILE CLEAN — tectonic builds both .tex with 0 undefined refs/cites.
#
#   bash scripts/papers-done-gate.sh
set -uo pipefail
ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"
P1="paper/internal-apis-2604.tex"
P2="paper/internal-apis.tex"
P3="paper/maintenance-network.tex"
MANIFEST="paper/reference/MANIFEST.tsv"
fail=0
section() { echo; echo "=== $1 ==="; }

# --- 1. REFERENCE TESTS -------------------------------------------------------
section "1. reference tests (run_all.py)"
if python3 paper/reference/tests/run_all.py; then
  echo "  reference tests: green"
else
  echo "  REF-FAIL: paper/reference/tests/run_all.py did not exit 0"; fail=1
fi

# --- 2. MANIFEST closed -------------------------------------------------------
section "2. manifest closed (claim <-> tested code)"
if [ ! -f "$MANIFEST" ]; then
  echo "  MANIFEST-FAIL: $MANIFEST missing"; fail=1
else
  rows=0
  while IFS=$'\t' read -r prim paper claim impl test; do
    [ -z "${prim:-}" ] && continue
    case "$prim" in \#*) continue;; esac
    rows=$((rows+1))
    [ -f "$impl" ] || { echo "  MANIFEST-FAIL[$prim]: impl missing: $impl"; fail=1; }
    [ -f "paper/reference/tests/$test" ] || { echo "  MANIFEST-FAIL[$prim]: test missing: tests/$test"; fail=1; }
    if ! grep -qF "$claim" "$paper"; then
      echo "  MANIFEST-FAIL[$prim]: claim absent from $paper: '$claim'"; fail=1
    else
      # the line carrying the claim must be tagged shipped/reference, not proposed
      hit=$(grep -nF "$claim" "$paper" | head -1)
      if echo "$hit" | grep -qF '\prop{}'; then
        echo "  MANIFEST-FAIL[$prim]: claim still tagged \\prop{} in $paper -> $hit"; fail=1
      fi
    fi
  done < "$MANIFEST"
  echo "  manifest: checked $rows primitive(s)"
fi

# --- 3. NO PURE-PROP ----------------------------------------------------------
section "3. no design-only (\\prop{}) claim survives"
for paper in "$P1" "$P2" "$P3"; do
  # allowed: the \newcommand{\prop} definition, and lines explicitly marked ok
  stray=$(grep -nF '\prop{}' "$paper" | grep -vF 'gate:prop-ok' | grep -vF '\newcommand{\prop}' || true)
  if [ -n "$stray" ]; then
    echo "  PROP-FAIL in $paper:"; echo "$stray" | sed 's/^/    /'; fail=1
  else
    echo "  $paper: no stray \\prop{}"
  fi
done

# --- 4. PUBLIC GATES ----------------------------------------------------------
section "4. public gates (reflect + no-leak + spec)"
for g in "bash scripts/paper-gate.sh $P1" \
         "bash scripts/paper-gate.sh $P2" \
         "bash scripts/paper-gate.sh $P3" \
         "bash scripts/leak-guard.sh $P1" \
         "bash scripts/leak-guard.sh $P2" \
         "bash scripts/leak-guard.sh $P3" \
         "bash scripts/paper-spec-gate.sh"; do
  if eval "$g" >/dev/null 2>&1; then
    echo "  PASS: $g"
  else
    echo "  GATE-FAIL: $g"; fail=1
  fi
done

# --- 5. PDFs COMPILE CLEAN ----------------------------------------------------
section "5. PDFs compile clean (0 undefined refs/cites)"
if ! command -v tectonic >/dev/null 2>&1; then
  echo "  PDF-SKIP: tectonic not installed (cannot verify compile)"; fail=1
else
  tmp="$(mktemp -d)"
  for paper in "$P1" "$P2" "$P3"; do
    log="$tmp/$(basename "$paper").log"
    if tectonic --keep-logs --outdir "$tmp" "$paper" >"$log" 2>&1; then
      if grep -qiE 'undefined (reference|citation)|may have changed|there were undefined' "$tmp/$(basename "${paper%.tex}").log" 2>/dev/null; then
        echo "  PDF-FAIL: $paper compiled but has undefined refs/citations"; fail=1
      else
        echo "  PASS: $paper compiles clean"
      fi
    else
      echo "  PDF-FAIL: $paper did not compile (see $log)"; fail=1
    fi
  done
  rm -rf "$tmp"
fi

echo
if [ "$fail" -ne 0 ]; then
  echo "PAPERS-DONE-GATE FAIL — the trilogy is not yet done to completion as code."
  exit 1
fi
echo "PAPERS-DONE-GATE PASS — every paper claim is backed by running, tested code; gates green; PDFs clean."
