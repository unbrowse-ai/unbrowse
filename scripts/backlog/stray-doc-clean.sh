#!/usr/bin/env bash
# stray-doc-clean.sh — docs reflect code: no references to the retired standalone
# SDK packages (@unbrowse/sdk, @unbrowse/client) outside their own deprecated
# package dirs. --check verifies clean; --fix rewrites them to `unbrowse/sdk`.
set -uo pipefail
REPO="$(cd "$(dirname "$0")/../.." && pwd)"; cd "$REPO"
mode="${1:---check}"
targets() { grep -rlE '@unbrowse/(sdk|client)' docs README.md 2>/dev/null | grep -vE 'packages/(sdk|sdk-v2)/'; }
if [ "$mode" = "--check" ]; then
  hits="$(targets || true)"
  if [ -n "$hits" ]; then echo "stray @unbrowse/sdk|client refs in:"; echo "$hits"; exit 1; fi
  echo "clean: no stray retired-SDK refs in docs/README"; exit 0
fi
if [ "$mode" = "--fix" ]; then
  for f in $(targets); do
    # @unbrowse/client -> unbrowse/sdk ; @unbrowse/sdk -> unbrowse/sdk (import path)
    sed -i '' -E 's#@unbrowse/client#unbrowse/sdk#g; s#npm i(nstall)? unbrowse/sdk#npm i unbrowse#g; s#@unbrowse/sdk#unbrowse/sdk#g' "$f"
    echo "fixed $f"
  done
  exit 0
fi
echo "usage: stray-doc-clean.sh [--check|--fix]"; exit 2
