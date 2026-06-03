#!/usr/bin/env bash
# Witness: the Windows E2E (test-windows.yml) on this branch concluded success.
#
# Exits 0 exactly when the latest test-windows.yml run on the branch — which
# builds kuri.exe from source on a real windows-latest runner, then runs
# kuri health → unbrowse health → go/snap/close — concluded `success`.
# Cannot be faked from this host; only a real Windows runner passing the browse
# test makes it green. On failure, prints the failing step(s) to point the walk.
set -uo pipefail

BRANCH="${WIN_CI_BRANCH:-jl/natural-selection}"
WF="test-windows.yml"

RID=$(gh run list --workflow="$WF" --branch "$BRANCH" --limit 1 --json databaseId -q '.[0].databaseId' 2>/dev/null)
if [ -z "$RID" ]; then echo "[win-ci] no test-windows run found on $BRANCH — dispatch one first"; exit 1; fi

echo "[win-ci] watching run $RID on $BRANCH ..."
until [ "$(gh run view "$RID" --json status -q '.status' 2>/dev/null)" = "completed" ]; do sleep 20; done

CONC=$(gh run view "$RID" --json conclusion -q '.conclusion' 2>/dev/null)
echo "[win-ci] run $RID conclusion=$CONC"
if [ "$CONC" = "success" ]; then
  echo "[win-ci] PASS — Windows E2E green (go/snap/close on windows-latest)."
  exit 0
fi

echo "[win-ci] failing steps:"
gh run view "$RID" --json jobs -q '.jobs[]? | .steps[]? | select(.conclusion=="failure") | "  ✗ " + .name' 2>/dev/null
exit 1
