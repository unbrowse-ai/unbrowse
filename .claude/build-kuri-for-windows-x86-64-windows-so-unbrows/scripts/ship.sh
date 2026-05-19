#!/usr/bin/env bash
# ship.sh - scoped, guarded ship for the Windows-Kuri harness.
#
# This harness spans TWO repos with strict rules:
#   - unbrowse-ai/unbrowse-dev  : vendor/CI/packaging changes -> PR only
#                                 (repo rule: never push directly to main).
#   - justrach/kuri (submodule) : Zig source changes -> a kuri-submodule
#                                 branch, pushed DELIBERATELY by a human/
#                                 explicit step (kuri is separately
#                                 maintained; auto-pushing a submodule
#                                 from a harness is forbidden).
#   - unbrowse-ai/unbrowse      : PUBLIC, frozen-by-design -> NEVER touched.
#
# So this script NEVER does `git add -A`, NEVER pushes a submodule, and
# NEVER pushes the public repo. It stages ONLY the explicit windows-build
# paths in the unbrowse-dev working tree and SURFACES the submodule +
# .github SSH-remote steps as commands for a human to run, rather than
# performing them silently.
set -uo pipefail
cd "$(dirname "$0")/../../.."          # -> unbrowse project root
PLAN=build-kuri-for-windows-x86-64-windows-so-unbrows

# Exact, scoped paths this harness is allowed to commit in unbrowse-dev.
WIN_PATHS=(
  ".github/workflows/kuri-windows-e2e.yml"
  "packages/skill/scripts/assert-kuri-vendor.mjs"
  "scripts/vendor-curl-impersonate-windows.sh"
  "CHANGELOG.md"
)

echo "[ship:$PLAN] surface: kuri submodule + unbrowse-dev vendor/CI (NOT cloudflare, NOT public repo)"

STAGED=0
for p in "${WIN_PATHS[@]}"; do
  if [[ -e "$p" ]] && ! git diff --quiet -- "$p" 2>/dev/null; then
    git add -- "$p" && STAGED=1 && echo "[ship:$PLAN] staged $p"
  elif [[ -e "$p" ]] && git ls-files --error-unmatch -- "$p" >/dev/null 2>&1; then
    : # tracked, unchanged
  elif [[ -e "$p" ]]; then
    git add -- "$p" && STAGED=1 && echo "[ship:$PLAN] staged (new) $p"
  fi
done

if [[ "$STAGED" -eq 0 ]]; then
  echo "[ship:$PLAN] TODO: declare - no windows-build path has changes to ship yet."
  echo "[ship:$PLAN] (the cross-compile blocker / workflow / vendor script are not authored or unchanged)"
  exit 0
fi

BR="fix/kuri-windows-build"
git rev-parse --verify -q "$BR" >/dev/null 2>&1 || git checkout -b "$BR"
git checkout "$BR" 2>/dev/null || true
git commit -m "feat(kuri-windows): cross-compile + windows-latest browse-E2E (harness: $PLAN)" || {
  echo "[ship:$PLAN] commit failed (hook?) - inspect, do not --no-verify"; exit 1; }

cat <<EOF
[ship:$PLAN] committed scoped windows paths on branch $BR (unbrowse-dev).
[ship:$PLAN] EXPLICIT human steps (this script will NOT do them):
  1. unbrowse-dev PR (never push main; .github changes need the SSH remote):
       git push github-ssh HEAD:refs/heads/$BR
       gh pr create --repo unbrowse-ai/unbrowse-dev --base main --head $BR
  2. kuri submodule Zig changes (separately maintained, deliberate push):
       cd submodules/kuri && git checkout -b windows-target
       git push <kuri-remote> HEAD:refs/heads/windows-target   # justrach/kuri
  3. PUBLIC unbrowse-ai/unbrowse stays frozen - close #76/#52/#109 only
     once the windows-latest browse-E2E is green on a real run.
EOF
exit 0
