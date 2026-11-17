#!/bin/sh
# Publishes npm tarballs in the order given, by trusted publishing (the workflow's GitHub identity, no token). A version
# npm already has with the same bytes is left as it is, so a rerun finishes what an earlier run started. One it has with
# other bytes fails the run: npm never takes a version twice, so these bytes will not reach anyone, and a run that went
# green here would lose them unseen. The update metadata meets this when another change took its number, which is the
# timestamp npm had plus one, between signing and publishing: a refresh after a release failed here, say. A package npm
# doesn't have at all can't be published this way: a trusted publisher is set in a package's settings on npmjs.com, which
# only a package that exists has. That is said before npm is asked, with what the owner does about it
# (docs/OPERATIONS.md §10).
#
#   usage: npm-publish.sh <version> <workflow file> <tarball>…
#
# <version> is the release's: the version a tarball of another (the update metadata's) is published at is its own.
# NPM_TAG is the dist-tag the release's packages go under (`latest` when unset): `staging` for a staging build, `next`
# for a release candidate, so `npm install unbrowse` only ever gets a shipped release. The update metadata is always
# `latest`: nodes read the newest.
set -eu

release=$1
workflow=$2
shift 2
repo=${GITHUB_REPOSITORY:-the repository}
for tgz in "$@"; do
  # A path npm is given must start with ./ or /: npm 11 reads `dist/x.tgz` as the GitHub repository `dist`.
  case $tgz in ./* | /*) ;; *) tgz=./$tgz ;; esac
  meta=$(tar -xzOf "$tgz" package/package.json)
  name=$(printf %s "$meta" | node -p 'JSON.parse(require("fs").readFileSync(0)).name')
  version=$(printf %s "$meta" | node -p 'JSON.parse(require("fs").readFileSync(0)).version')
  if ! npm view "$name" name >/dev/null 2>&1; then
    echo "::error::npm has no $name, and trusted publishing can't create a package. Publish it once by hand as a member of the npm org (npm publish --access public, any version), then on npmjs.com give $name a trusted publisher (GitHub Actions, $repo, workflow $workflow, environment release) and rerun this job"
    exit 1
  fi
  if npm view "$name@$version" version >/dev/null 2>&1; then
    held=$(npm view "$name@$version" dist.integrity)
    mine=sha512-$(node -p 'require("crypto").createHash("sha512").update(require("fs").readFileSync(process.argv[1])).digest("base64")' "$tgz")
    if [ "$held" = "$mine" ]; then
      echo "$name@$version is on npm already"
      continue
    fi
    case $name in
      */updates) how="Another change took this number after this run signed. Rerun this workflow's Sign the update metadata job and what depends on it: it signs on top of what npm has now" ;;
      *) how="An earlier run published this version from another build. Nothing later in this run was published: start a new run for a staging or release-candidate build, or tag the next patch for a release" ;;
    esac
    echo "::error::npm has $name@$version with other bytes ($held, this run has $mine), and npm never takes a version twice, so this run's were not published. $how"
    exit 1
  fi
  case $name in */updates) tag=latest ;; *) tag=${NPM_TAG:-latest} ;; esac
  if ! npm publish "$tgz" --access public --tag "$tag" --provenance; then
    echo "::error::npm refused $name@$version (its error is above). If it couldn't authenticate (ENEEDAUTH), $name has no trusted publisher for this run: on npmjs.com give it one (GitHub Actions, $repo, workflow $workflow, environment release), then rerun this job"
    exit 1
  fi
done
echo "published release $release's packages"
