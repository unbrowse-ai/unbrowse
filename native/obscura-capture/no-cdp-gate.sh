#!/usr/bin/env bash
# no-cdp-gate.sh — the "no need for CDP" witness.
#
# Every v7 CLI handler that imports src/cdp must ALSO have an obscura path:
# either a live branch (isObscuraSession / obscuraBackendSelected) or an
# explicit, documented refusal (unsupported_on_obscura:*). A handler with a CDP
# import and neither is one that still NEEDS Chrome — this gate names it and
# fails. Fail-closed; the allowlist is empty on purpose.
#
# This is a static gate: it proves reachability, not behaviour. The behavioural
# proof is cli-e2e-gate.sh (real CLI, live page, asserts 0 new Chrome processes).
set -uo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
repo="$(cd "$here/../.." && pwd)"
cd "$repo"

missing=0
checked=0
refusing=0
wired=0

for f in src/cli-v7/breath/*.ts src/cli-v7/eval/*.ts; do
  # Only handlers that actually reach the Chrome primitives are in scope.
  grep -qE 'from "\.\./\.\./cdp/' "$f" 2>/dev/null || continue
  checked=$((checked + 1))
  name="$(basename "$f")"
  if grep -qE 'unsupported_on_obscura' "$f" 2>/dev/null; then
    refusing=$((refusing + 1))
    echo "  refuses  $name  (documented capability gap)"
  elif grep -qE 'isObscuraSession|obscuraBackendSelected' "$f" 2>/dev/null; then
    wired=$((wired + 1))
    echo "  wired    $name"
  else
    echo "  NEEDS-CDP $name  — no obscura branch and no documented refusal" >&2
    missing=$((missing + 1))
  fi
done

echo ""
echo "handlers importing src/cdp: $checked  (wired: $wired, refusing: $refusing, unhandled: $missing)"

if [ "$checked" -eq 0 ]; then
  echo "NO-CDP-GATE FAIL: scanned zero handlers — the scan pattern is wrong, not the code" >&2
  exit 1
fi
if [ "$missing" -ne 0 ]; then
  echo "NO-CDP-GATE FAIL: $missing handler(s) still need CDP with no obscura path" >&2
  exit 1
fi

echo "NO-CDP-GATE PASS: every CDP-importing CLI handler has an obscura path or a documented refusal"
