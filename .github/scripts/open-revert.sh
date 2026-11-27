#!/usr/bin/env bash
# Opens a pull request into staging that reverts one commit, and starts CI on it. It merges nothing: a person merges the
# revert, or fixes forward and closes it. staging-revert.yml (a merge that turned staging red) and pr-closed.yml (a merge
# made with checks not green, UNB-248) both open theirs here, on one branch per commit, so the two never open two.
#
#   open-revert.sh <sha> <title> <body>     prints the revert pull request's address
#
# Needs GH_TOKEN and REPO. ORIGIN is the repository's git address (GitHub's by default).
set -euo pipefail
sha=$1 title=$2 body=$3
: "${REPO:?}" "${GH_TOKEN:?}"
origin=${ORIGIN:-https://github.com/$REPO.git}
branch="revert/${sha:0:12}"
if gh api "repos/$REPO/branches/$branch" > /dev/null 2>&1; then
  echo "the revert of ${sha:0:8} is already open on $branch" >&2
  gh pr list --repo "$REPO" --head "$branch" --state all --json url --jq '.[0].url // empty'
  exit 0
fi
parents=$(gh api "repos/$REPO/commits/$sha" --jq '.parents | length')
work=$(mktemp -d "${RUNNER_TEMP:-${TMPDIR:-/tmp}}/revert.XXXXXX")
git init -q "$work"
cd "$work"
git remote add origin "$origin"
auth="AUTHORIZATION: basic $(printf 'x-access-token:%s' "$GH_TOKEN" | base64 | tr -d '\n')"
git -c http.extraheader="$auth" fetch -q --depth=2 origin "$sha"
git checkout -q --detach FETCH_HEAD
mainline=()
[ "$parents" -gt 1 ] && mainline=(-m 1)
git -c user.name='github-actions[bot]' -c user.email='41898282+github-actions[bot]@users.noreply.github.com' \
  revert --no-edit "${mainline[@]}" "$sha" > /dev/null
git -c http.extraheader="$auth" push -q origin "HEAD:refs/heads/$branch"
# A pull request the workflow token opens starts no workflow by itself: CI is started by hand.
url=$(gh pr create --repo "$REPO" --base staging --head "$branch" --title "$title" --body "$body")
gh workflow run ci.yml --repo "$REPO" --ref "$branch" >&2 || echo "CI did not start on $branch; start it by hand" >&2
echo "$url"
