#!/bin/sh
# The promotion gate on the tree about to ship (UNB-208): fetches what CI measured on that tree and asks
# promotion_gate.py whether it may go to public.
#
#   promotion-gate.sh <tree> <folder>
#
# Reads three artifacts of this repository by name: `coverage-summary-<tree>` (coverage.yml, on the push of the release
# branch), `gate-bank-full-<tree>` (gate-bank.yml, the whole bank on that push) and `gate-1k-<tree>` (gate-1k.yml, the
# top 1,000 sites on that push, UNB-307: its results, the runner it ran on, and the regressions to re-read). A missing
# one is UNMEASURED, which the gate refuses. Needs GH_TOKEN with actions: read, and gh, unzip and python3; installs
# nothing and runs nothing it downloads: the artifacts are JSON and text, read by promotion_gate.py from the checkout.
# Exits 1 when the gate refuses, printing each rule unmet.
set -eu

tree=$1
dir=$2
mkdir -p "$dir"

for name in "coverage-summary-$tree" "gate-bank-full-$tree" "gate-1k-$tree"; do
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

python3 -I .github/scripts/promotion_gate.py check \
  --coverage "$dir/coverage-summary-$tree/coverage-summary.json" \
  --bank-results "$dir/gate-bank-full-$tree/results.jsonl" \
  --top1k-results "$dir/gate-1k-$tree/results.jsonl" \
  --top1k-meta "$dir/gate-1k-$tree/meta.json" \
  --top1k-rereads "$dir/rereads.json" \
  --md "$dir/verdict.md"
