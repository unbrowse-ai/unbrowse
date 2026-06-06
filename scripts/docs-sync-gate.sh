#!/usr/bin/env bash
# docs-sync-gate — the jesus-ralph witness for "docs match code, website matches docs".
# Aggregates the repo's OWN sync gates (its native definition of "synced/clean") plus
# a current-version consistency check. Exits 0 EXACTLY when nothing is out of sync.
set -uo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT" || exit 2
fail=0
run() { # label, cmd...
  local label="$1"; shift
  if "$@" >"/tmp/dsg-${label}.log" 2>&1; then echo "ok   $label"; else echo "FAIL $label  (see /tmp/dsg-${label}.log)"; fail=1; fi
}

run docs-clean        bash scripts/docs-clean-gate.sh
run audit-public-docs bash scripts/audit-public-docs.sh
run validate-sdk-docs bash scripts/validate-sdk-docs.sh
run docs-site-adapters bash scripts/docs-site-adapters-gate.sh
for p in internal-apis-are-all-you-need crypto-was-all-you-needed unbrowse-maintenance-network; do
  run "paper-${p}" bash scripts/paper-gate.sh "paper/${p}.tex"
done

# Current-version consistency: the canonical published version is the npm `unbrowse`
# version; the machine-read JSON-LD softwareVersion must match it (no stale claim).
# Public docs advertise the latest STABLE release — an in-flight preview prerelease
# (e.g. 8.3.0-preview.0 in package.json) must NOT force the public site to claim a preview.
VER="$(node -e "console.log(require('./package.json').version)" 2>/dev/null)"
case "$VER" in *-*) VER="$(git tag --list 'v*' --sort=-v:refname | grep -vE '\-' | head -1 | sed 's/^v//')";; esac
if grep -q "softwareVersion: \"${VER}\"" frontend/src/app/layout.tsx 2>/dev/null; then
  echo "ok   version-jsonld (softwareVersion=${VER})"
else
  echo "FAIL version-jsonld (layout.tsx softwareVersion != ${VER})"; fail=1
fi

[ "$fail" = "0" ] && echo "GATE GREEN" || echo "GATE RED"
exit $fail
