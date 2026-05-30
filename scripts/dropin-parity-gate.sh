#!/usr/bin/env bash
# scripts/dropin-parity-gate.sh — the drop-in parity witness.
#
# For every significant upstream library declared in scripts/dropin-manifest.tsv,
# prove Unbrowse ships a TRUE, zero-edit drop-in for it:
#   PKG   the shim package exists
#   ATTR  its README attributes the upstream (names the upstream package)
#   DROP  its README documents the drop-in swap (says "drop-in")
#   TEST  its parity test passes (the upstream's public surface is provided)
#
# Exit 0 iff every committed gap is filled. This is the gate for /jesus-ralph:
# it stays RED while any significant library lacks a parity-verified drop-in,
# and goes GREEN only when they are all filled. No string can fake it — a row
# only flips green when a real shim with a passing parity test exists on disk.

set -uo pipefail
ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
MANIFEST="$ROOT_DIR/scripts/dropin-manifest.tsv"
cd "$ROOT_DIR"

red=0
total=0
printf '%-28s %-26s  %s\n' "UPSTREAM" "DROP-IN" "PKG ATTR DROP TEST"
printf '%s\n' "------------------------------------------------------------------------------------"

while IFS=$'\t' read -r upstream shim shim_path readme parity_test; do
  # skip comments / blanks
  [[ -z "${upstream// }" || "${upstream:0:1}" == "#" ]] && continue
  total=$((total+1))

  pkg=FAIL attr=FAIL drop=FAIL test=FAIL

  [[ -f "$shim_path/package.json" ]] && pkg=ok

  if [[ -f "$readme" ]]; then
    grep -qiF -- "$upstream" "$readme" && attr=ok
    grep -qi -- "drop-in" "$readme" && drop=ok
  fi

  if [[ -f "$parity_test" ]]; then
    if bun test "$parity_test" >/dev/null 2>&1; then test=ok; fi
  fi

  row_ok=1
  for v in "$pkg" "$attr" "$drop" "$test"; do [[ "$v" == ok ]] || row_ok=0; done
  [[ $row_ok -eq 1 ]] || red=$((red+1))

  printf '%-28s %-26s  %-3s %-4s %-4s %s\n' "$upstream" "$shim" "$pkg" "$attr" "$drop" "$test"
done < "$MANIFEST"

printf '%s\n' "------------------------------------------------------------------------------------"
green=$((total-red))
printf 'drop-in parity: %d/%d green\n' "$green" "$total"
if [[ $red -gt 0 ]]; then
  printf '%d gap(s) remain — not every significant library has a parity-verified drop-in yet.\n' "$red"
  exit 1
fi
printf 'every committed drop-in is parity-verified. Distribution ledger: scripts/dropin-distribution.tsv\n'
exit 0
