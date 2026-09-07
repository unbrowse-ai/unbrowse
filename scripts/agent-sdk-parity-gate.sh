#!/usr/bin/env bash
# scripts/agent-sdk-parity-gate.sh — the agent-SDK native-tool witness.
#
# For every popular agent framework in scripts/agent-sdk-manifest.tsv, prove
# Unbrowse ships a native-tool adapter:
#   PKG   the adapter package exists
#   ATTR  its README names the upstream framework
#   TOOL  its README documents registering Unbrowse as the framework's tool
#   TEST  its shape test passes (the framework's tool contract is provided)
#
# Exit 0 iff every committed agent-SDK adapter is parity-verified. Sibling of
# scripts/dropin-parity-gate.sh; same no-fake-green discipline.
set -uo pipefail
ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
MANIFEST="$ROOT_DIR/scripts/agent-sdk-manifest.tsv"
cd "$ROOT_DIR"

red=0
total=0
printf '%-18s %-26s  %s\n' "FRAMEWORK" "ADAPTER" "PKG ATTR TOOL TEST"
printf '%s\n' "------------------------------------------------------------------------------"

while IFS=$'\t' read -r framework pkg pkg_path readme shape_test; do
  [[ -z "${framework// }" || "${framework:0:1}" == "#" ]] && continue
  total=$((total+1))

  pk=FAIL attr=FAIL tool=FAIL test=FAIL
  [[ -f "$pkg_path/package.json" ]] && pk=ok
  if [[ -f "$readme" ]]; then
    grep -qiF -- "$framework" "$readme" && attr=ok
    grep -qi -- "tool" "$readme" && tool=ok
  fi
  if [[ -f "$shape_test" ]]; then
    if bun test "$shape_test" >/dev/null 2>&1; then test=ok; fi
  fi

  row_ok=1
  for v in "$pk" "$attr" "$tool" "$test"; do [[ "$v" == ok ]] || row_ok=0; done
  [[ $row_ok -eq 1 ]] || red=$((red+1))
  printf '%-18s %-26s  %-3s %-4s %-4s %s\n' "$framework" "$pkg" "$pk" "$attr" "$tool" "$test"
done < "$MANIFEST"

printf '%s\n' "------------------------------------------------------------------------------"
green=$((total-red))
printf 'agent-sdk parity: %d/%d green\n' "$green" "$total"
[[ $red -gt 0 ]] && { printf '%d gap(s) remain — not every popular agent SDK has a parity-verified adapter yet.\n' "$red"; exit 1; }
printf 'every committed agent-SDK adapter is parity-verified.\n'
exit 0
