#!/bin/sh
# Packs `unbrowse` for npm and PyPI around the machines' packages pack-platforms.sh made: each carries the agent skill
# and the client. On npm, `unbrowse` names each machine's package as an optional dependency, so npm fetches only the one
# that runs where it installs, and carries the release's signed manifest (manifest.json, manifest.sig), which nodes read
# to update. On PyPI each machine has a wheel tagged for it, with its programs inside (on a Mac Unbrowse.app, elsewhere
# `bin`), and a plain wheel is the client for any other.
#
#   usage: pack-sdks.sh <version> <out-dir>
#
# <out-dir> holds pack-platforms.sh's packages and manifest (and the signature, when the release signed it).
set -eu

version=$1
out=$(cd "$2" && pwd)
root=$(git rev-parse --show-toplevel)

stage=$(mktemp -d)
trap 'rm -rf "$stage"' EXIT

# platform  wheel tag. Linux is built on Ubuntu 22.04, whose glibc is 2.35.
tags="darwin-arm64 macosx_11_0_arm64
darwin-x64 macosx_11_0_x86_64
linux-x64 manylinux_2_35_x86_64
linux-arm64 manylinux_2_35_aarch64
win32-x64 win_amd64"
echo "$tags" | while read -r platform tag; do
  [ -f "$out/unbrowse-$platform-$version.tgz" ] && echo "$platform $tag" >> "$stage/machines"
done
[ -s "$stage/machines" ] || { echo "pack-sdks.sh: no machines' packages in $out"; exit 1; }

# The Team ID the Mac apps are signed by, from their packages (pack-platforms.sh): every signed one must say the same,
# and a release that signs one signs all. `unbrowse` pins it, and its CLI runs an Unbrowse.app found outside the
# package only when that app is signed by this team (unbrowse-sdk/typescript/src/cli.ts, trustedApp).
team=""
macs=0
while read -r platform tag; do
  case $platform in darwin-*) ;; *) continue ;; esac
  macs=$((macs + 1))
  said=$(tar -xzOf "$out/unbrowse-$platform-$version.tgz" package/package.json | python3 -I -c 'import json,sys; print(json.load(sys.stdin).get("unbrowseAppTeam", ""))')
  [ -n "$said" ] || continue
  [ -z "$team" ] || [ "$team" = "$said" ] || { echo "pack-sdks.sh: the Mac apps name two teams, $team and $said"; exit 1; }
  team=$said
  echo "$platform" >> "$stage/pinned"
done < "$stage/machines"
if [ -n "$team" ] && [ "$(wc -l < "$stage/pinned")" -ne "$macs" ]; then
  echo "pack-sdks.sh: some Mac apps are signed by $team and some name no team"; exit 1
fi

# npm: the package that names each machine's programs, with the manifest.
ts=$root/unbrowse-sdk/typescript
rm -rf "$ts/skill" "$ts/manifest.json" "$ts/manifest.sig"
cp -R "$root/skills/unbrowse" "$ts/skill"
cp "$out/manifest.json" "$ts/"
[ -f "$out/manifest.sig" ] && cp "$out/manifest.sig" "$ts/"
(
  cd "$ts"
  npm ci --ignore-scripts
  npm run build
  # Named after the install, which would otherwise look for platform packages not yet published.
  npm version "$version" --no-git-tag-version --allow-same-version >/dev/null
  while read -r platform tag; do npm pkg set "optionalDependencies.@unbrowse/$platform=$version"; done < "$stage/machines"
  if [ -n "$team" ]; then npm pkg set "unbrowseAppTeam=$team"; else npm pkg delete unbrowseAppTeam; fi
  # npm's trusted publishing takes a package only when its repository is the one the workflow runs in.
  if [ -n "${GITHUB_REPOSITORY:-}" ]; then
    npm pkg set repository.type=git "repository.url=git+${GITHUB_SERVER_URL:-https://github.com}/$GITHUB_REPOSITORY.git"
  fi
  npm pack --pack-destination "$out" >/dev/null
)

# PyPI: the client for any Python 3, then a wheel for each machine with its programs in it.
py=$root/unbrowse-sdk/python
rm -rf "$py/src/unbrowse/skill" "$py/src/unbrowse/Unbrowse.app" "$py/src/unbrowse/bin" "$py/src/unbrowse/app-team"
cp -R "$root/skills/unbrowse" "$py/src/unbrowse/skill"
# The same pin as the npm package's `unbrowseAppTeam`: the Python CLI runs an Unbrowse.app found outside the package
# only when this team signed it (unbrowse-sdk/python/src/unbrowse/cli.py, trusted_app).
[ -z "$team" ] || printf '%s\n' "$team" > "$py/src/unbrowse/app-team"
# PyPI's versions are PEP 440's: a release candidate's 13.19.0-rc.7 is 13.19.0rc7, a staging build's 13.20.0-staging.9
# is 13.20.0.dev9.
case $version in
  *-rc.*) pyversion=${version%%-*}rc${version##*.} ;;
  *-staging.*) pyversion=${version%%-*}.dev${version##*.} ;;
  *-*) echo "pack-sdks.sh: no PyPI version for $version"; exit 1 ;;
  *) pyversion=$version ;;
esac
sed -i.bak "s/^version = \".*\"/version = \"$pyversion\"/" "$py/pyproject.toml" && rm "$py/pyproject.toml.bak"
grep -qx "version = \"$pyversion\"" "$py/pyproject.toml"
python3 -m pip install --disable-pip-version-check --no-deps --require-hashes -r "$root/.github/scripts/requirements-release.txt"
python3 -m build --no-isolation --outdir "$out" "$py"
while read -r platform tag; do
  mkdir "$stage/$platform"
  tar -xzf "$out/unbrowse-$platform-$version.tgz" -C "$stage/$platform"
  what=bin; [ -d "$stage/$platform/package/Unbrowse.app" ] && what=Unbrowse.app
  cp -Rp "$stage/$platform/package/$what" "$py/src/unbrowse/$what"
  UNBROWSE_WHEEL_TAG="py3-none-$tag" python3 -m build --no-isolation --wheel --outdir "$out" "$py"
  rm -rf "$py/src/unbrowse/$what"
done < "$stage/machines"

ls -1 "$out"
