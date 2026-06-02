#!/usr/bin/env bash
# scripts/python-adapter-gate.sh — the Python-layer adapter witness.
#
# For every popular Python library in scripts/python-adapter-manifest.tsv, prove
# Unbrowse ships a parity-verified adapter (HTTP drop-in or agent native tool):
#   PKG   the package exists (pkg_dir/pyproject.toml)
#   ATTR  its README names the upstream
#   SWAP  its README says "drop-in" (HTTP) or "tool" (agent)
#   TEST  `python3 <test>` exits 0 (the upstream's public surface is provided)
#
# Exit 0 iff every committed Python adapter is parity-verified. Sibling of the JS
# scripts/dropin-parity-gate.sh; same no-fake-green discipline (a row goes green
# only when a real package with a passing python3 test exists on disk).
set -uo pipefail
ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
MANIFEST="$ROOT_DIR/scripts/python-adapter-manifest.tsv"
cd "$ROOT_DIR"
PY="$(command -v python3 || command -v python)"

red=0
total=0
printf '%-14s %-24s  %s\n' "UPSTREAM" "ADAPTER" "PKG ATTR SWAP TEST"
printf '%s\n' "----------------------------------------------------------------------"

while IFS=$'\t' read -r upstream pkg pkg_dir readme test; do
  [[ -z "${upstream// }" || "${upstream:0:1}" == "#" ]] && continue
  total=$((total+1))

  pk=FAIL attr=FAIL swap=FAIL tst=FAIL
  [[ -f "$pkg_dir/pyproject.toml" ]] && pk=ok
  if [[ -f "$readme" ]]; then
    grep -qiF -- "$upstream" "$readme" && attr=ok
    { grep -qi -- "drop-in" "$readme" || grep -qi -- "tool" "$readme"; } && swap=ok
  fi
  if [[ -f "$test" && -n "$PY" ]]; then
    if "$PY" "$test" >/dev/null 2>&1; then tst=ok; fi
  fi

  row_ok=1
  for v in "$pk" "$attr" "$swap" "$tst"; do [[ "$v" == ok ]] || row_ok=0; done
  [[ $row_ok -eq 1 ]] || red=$((red+1))
  printf '%-14s %-24s  %-3s %-4s %-4s %s\n' "$upstream" "$pkg" "$pk" "$attr" "$swap" "$tst"
done < "$MANIFEST"

printf '%s\n' "----------------------------------------------------------------------"
green=$((total-red))
printf 'python adapter parity: %d/%d green\n' "$green" "$total"
[[ $red -gt 0 ]] && { printf '%d gap(s) remain — not every popular Python library has a parity-verified adapter yet.\n' "$red"; exit 1; }
printf 'every committed Python adapter is parity-verified.\n'
exit 0
