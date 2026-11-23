#!/bin/sh
# The promotion gate on the tree about to ship (UNB-208): fetches what CI measured on that tree and asks
# promotion_gate.py whether it may go to public.
#
#   promotion-gate.sh <tree> <folder>
#
# Reads two artifacts of this repository by name: `coverage-summary-<tree>` (coverage.yml, on the push of the release
# branch) and `gate-bank-full-<tree>` (gate-bank.yml, the whole bank on that push). A missing one is UNMEASURED, which
# the gate refuses. Needs GH_TOKEN with actions: read, and gh, unzip and python3; installs nothing and runs nothing it
# downloads: the artifacts are JSON and text, read by promotion_gate.py from the checkout. Exits 1 when the gate
# refuses, printing each rule unmet.
set -eu

tree=$1
dir=$2
mkdir -p "$dir"

for name in "coverage-summary-$tree" "gate-bank-full-$tree"; do
  id=$(gh api "repos/$GITHUB_REPOSITORY/actions/artifacts?name=$name&per_page=20" \
    --jq '[.artifacts[] | select(.expired | not)][0].id // empty')
  if [ -z "$id" ]; then
    echo "no artifact $name: its part is UNMEASURED"
    continue
  fi
  gh api "repos/$GITHUB_REPOSITORY/actions/artifacts/$id/zip" > "$dir/$name.zip"
  unzip -o -q "$dir/$name.zip" -d "$dir/$name"
  echo "read artifact $name ($id)"
done

# A waiver names one version, one rule and why, in .github/promotion-waivers (`<version> coverage <reason>` or
# `<version> bank <reason>`): that release is gated on the other rule alone, and each waiver is printed. A release with
# both waived has nothing left to measure and goes on. Any other version still needs both.
only=""
if [ -n "${VERSION:-}" ] && [ -f .github/promotion-waivers ]; then
  waived() { awk -v v="$VERSION" -v k="$1" '$1 == v && $2 == k { $1 = ""; $2 = ""; sub(/^ +/, ""); print; exit }' .github/promotion-waivers; }
  cov=$(waived coverage)
  bank=$(waived bank)
  [ -z "$cov" ] || echo "::warning::code coverage waived for $VERSION: $cov"
  [ -z "$bank" ] || echo "::warning::the task bank waived for $VERSION: $bank"
  if [ -n "$cov" ] && [ -n "$bank" ]; then
    printf 'PROMOTION_WAIVED: coverage and the task bank are both waived for %s (.github/promotion-waivers)\n' "$VERSION" | tee "$dir/verdict.md"
    exit 0
  fi
  if [ -n "$cov" ]; then only="--tasks-only"; fi
  if [ -n "$bank" ]; then only="--coverage-only"; fi
fi

python3 -I .github/scripts/promotion_gate.py check $only \
  --coverage "$dir/coverage-summary-$tree/coverage-summary.json" \
  --bank-results "$dir/gate-bank-full-$tree/results.jsonl" \
  --md "$dir/verdict.md"
