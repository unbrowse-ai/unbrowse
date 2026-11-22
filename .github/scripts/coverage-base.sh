#!/bin/sh
# Staging's coverage summaries for the coverage ratchet (UNB-208), nearest first.
#
#   coverage-base.sh <commit> <folder>
#
# Walks <commit>'s first-parent history (at most 30 commits) and, for each commit whose tree has an unexpired artifact
# `coverage-summary-<tree>` (coverage.yml, on a push to staging), downloads it and prints the summary's path. Stops after
# five: the ratchet compares each part with the lowest of them that measured it, so a staging run that lost a job, was
# cancelled by the next push or had a Chrome the pull request's run did not is not held against it. Prints nothing when
# none is found, which the ratchet refuses as UNMEASURED. Needs GH_TOKEN with actions: read, gh, git and unzip; runs nothing it downloads.
set -eu

commit=$1
dir=$2
mkdir -p "$dir"
found=0

for c in $(git rev-list --first-parent -n 30 "$commit"); do
  tree=$(git rev-parse "$c^{tree}")
  id=$(gh api "repos/$GITHUB_REPOSITORY/actions/artifacts?name=coverage-summary-$tree&per_page=20" \
    --jq '[.artifacts[] | select(.expired | not)][0].id // empty')
  [ -n "$id" ] || continue
  gh api "repos/$GITHUB_REPOSITORY/actions/artifacts/$id/zip" > "$dir/$c.zip"
  unzip -o -q "$dir/$c.zip" -d "$dir/$c"
  [ -f "$dir/$c/coverage-summary.json" ] || continue
  echo "staging summary for $c (artifact $id)" >&2
  echo "$dir/$c/coverage-summary.json"
  found=$((found + 1))
  [ "$found" -lt 5 ] || break
done
