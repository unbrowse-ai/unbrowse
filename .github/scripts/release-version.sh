#!/bin/sh
# Prints the version a release of HEAD gets, from the ref it was made for (CONTRIBUTING.md, "Branches and releases"):
#
#   refs/heads/staging        X.Y.0-staging.N   staging: X.Y is one minor above the newest release branch or tag
#   refs/heads/release/X.Y    X.Y.P-rc.N        pre-production: P is 0 until vX.Y.0 is tagged, then one above the
#                                               highest vX.Y.p tag
#   refs/tags/vX.Y.Z          X.Y.Z             production: the tag's own, and only for a commit on main whose tree is
#                                               release/X.Y's, since main ships what the release branch tested
#
# N is the release run's number, so each run has a version of its own: npm never takes one twice. The branches are
# read from the checkout's remote refs and the tags from its tags, so the checkout needs them all (fetch-depth: 0).
# Anything else is refused: no other branch releases.
#
#   usage: release-version.sh <ref> <run number>
set -eu

ref=$1
run=$2
case $run in '' | *[!0-9]*) echo "release-version.sh: the run number is a whole number, not '$run'" >&2; exit 2 ;; esac

# Every vX.Y.Z tag and every release/X.Y branch, as X.Y.Z and X.Y.
tags=$(git tag --list 'v*' | sed -n 's/^v\([0-9][0-9]*\.[0-9][0-9]*\.[0-9][0-9]*\)$/\1/p')
lines=$(git for-each-ref --format='%(refname:lstrip=4)' refs/remotes/origin/release/ | grep -E '^[0-9]+\.[0-9]+$' || true)

case $ref in
  refs/heads/staging)
    newest=$({ echo "$tags" | cut -d. -f1,2; echo "$lines"; } | grep . | sort -t. -k1,1n -k2,2n | tail -n 1)
    [ -n "$newest" ] || { echo "release-version.sh: no vX.Y.Z tag or release/X.Y branch to count from" >&2; exit 1; }
    echo "${newest%.*}.$((${newest#*.} + 1)).0-staging.$run"
    ;;
  refs/heads/release/*)
    line=${ref#refs/heads/release/}
    echo "$line" | grep -qE '^[0-9]+\.[0-9]+$' || { echo "release-version.sh: a release branch is release/MAJOR.MINOR, not release/$line" >&2; exit 1; }
    last=$(echo "$tags" | grep -E "^$(echo "$line" | sed 's/\./\\./')\.[0-9]+$" | cut -d. -f3 | sort -n | tail -n 1)
    echo "$line.$(( ${last:--1} + 1 ))-rc.$run"
    ;;
  refs/tags/v*)
    version=${ref#refs/tags/v}
    echo "$version" | grep -qE '^[0-9]+\.[0-9]+\.[0-9]+$' || { echo "release-version.sh: a release tag is vMAJOR.MINOR.PATCH, not v$version" >&2; exit 1; }
    line=${version%.*}
    git rev-parse -q --verify "refs/remotes/origin/main^{commit}" >/dev/null || { echo "release-version.sh: the checkout has no origin/main" >&2; exit 1; }
    git merge-base --is-ancestor HEAD refs/remotes/origin/main || { echo "release-version.sh: v$version isn't on main: only a release merged into main ships" >&2; exit 1; }
    git rev-parse -q --verify "refs/remotes/origin/release/$line^{commit}" >/dev/null || { echo "release-version.sh: there's no release/$line for v$version" >&2; exit 1; }
    [ "$(git rev-parse HEAD^{tree})" = "$(git rev-parse "refs/remotes/origin/release/$line^{tree}")" ] ||
      { echo "release-version.sh: v$version's tree isn't release/$line's: main must ship what the release branch tested" >&2; exit 1; }
    echo "$version"
    ;;
  *)
    echo "release-version.sh: $ref doesn't release: staging, release/X.Y and vX.Y.Z tags on main do" >&2
    exit 1
    ;;
esac
