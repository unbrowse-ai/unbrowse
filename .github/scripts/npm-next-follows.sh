#!/bin/sh
# Moves each package's `next` dist-tag up to a shipped release when `next` is older, so `npm install unbrowse@next`
# never installs a release candidate the shipped release has passed (13.0.0-rc.151 after 13.0.0 shipped: the network
# refuses it, and the node is left to its self-update). A `next` that is newer than the release (a candidate for the
# release after it) is left where it is.
#
#   usage: npm-next-follows.sh <version> <package name>…
#
# Each package's platform packages (its optionalDependencies at that version, @unbrowse/darwin-arm64 and the rest) are
# moved with it, so the job needs nothing but the names.
#
# npm authenticates `npm dist-tag` by trusted publishing, the workflow's own GitHub identity (npm 11.21.0 / 12.2.0 or
# later, `id-token: write`): no token. Each package's trusted publisher needs "Allow npm dist-tag" turned on in its
# settings on npmjs.com (off by default). A package where npm refuses is named with that, and the run fails once every
# package has been tried.
set -eu

version=$1
shift
behind() { # $1 next, $2 release: true when next sorts before the release (semver, a pre-release before its release)
  node -e '
    const p = v => { const [core, pre] = v.split("-", 2); return [core.split(".").map(Number), pre] };
    const [[a, ap], [b, bp]] = [p(process.argv[1]), p(process.argv[2])];
    for (let i = 0; i < 3; i++) if (a[i] !== b[i]) process.exit(a[i] < b[i] ? 0 : 1);
    process.exit(ap !== undefined && bp === undefined ? 0 : 1);
  ' "$1" "$2"
}
names=
for name in "$@"; do
  deps=$(npm view "$name@$version" optionalDependencies --json 2>/dev/null || true)
  names="$names $name $(printf %s "$deps" | node -e 'let t="";process.stdin.on("data",d=>t+=d).on("end",()=>{try{console.log(Object.keys(JSON.parse(t||"{}")).join(" "))}catch{console.log("")}})')"
done
# shellcheck disable=SC2086 # the names are npm package names: no spaces, no globs
set -- $names
refused=
for name in "$@"; do
  next=$(npm view "$name" dist-tags.next 2>/dev/null || true)
  if [ -z "$next" ] || ! behind "$next" "$version"; then
    echo "$name: next is ${next:-unset}, left as it is"
    continue
  fi
  if npm dist-tag add "$name@$version" next; then
    echo "$name: next moved from $next to $version"
  else
    echo "::error::npm refused to move $name's next from $next to $version (its error is above). If it couldn't authenticate, turn on \"Allow npm dist-tag\" for $name's trusted publisher (GitHub Actions, ${GITHUB_REPOSITORY:-this repository}, release.yml, environment release) on npmjs.com, then rerun"
    refused="$refused $name"
  fi
done
[ -z "$refused" ] || exit 1
