#!/bin/sh
# Packs the Windows installer, Unbrowse-<version>-windows-x64-setup.exe, from the release's
# unbrowse-<version>-windows-x64.zip (package-programs.sh). Runs on Linux with makensis (apt: nsis) and 7z; the
# installer script is .github/installers/windows/unbrowse.nsi, which says what it installs.
#
#   usage: package-windows-installer.sh <version> <programs zip> <out-dir>
set -eu

version=$1
zip=$2
mkdir -p "$3"
out=$(cd "$3" && pwd)
root=$(git rev-parse --show-toplevel)
# The installer's file version is four numbers: a prerelease's X.Y.Z, then 0.
numeric="${version%%-*}.0"
echo "$numeric" | grep -qE '^[0-9]+\.[0-9]+\.[0-9]+\.0$' || { echo "package-windows-installer.sh: $version isn't X.Y.Z[-pre]" >&2; exit 1; }

stage=$(mktemp -d)
trap 'rm -rf "$stage"' EXIT
7z x -bso0 -o"$stage/zip" "$zip"
programs=$(find "$stage/zip" -mindepth 1 -maxdepth 1 -type d | head -n 1)
for p in unbrowse-node.exe unb.exe agent-browser.exe unbrowse-window.exe README.md; do
  test -f "$programs/$p" || { echo "package-windows-installer.sh: $zip has no $p" >&2; exit 1; }
done
cp "$root/.github/installers/windows/unbrowse.nsi" "$root/.github/installers/windows/unbrowse.ico" "$stage/"
setup="$out/Unbrowse-$version-windows-x64-setup.exe"
(cd "$stage" && makensis -V2 -WX -DVERSION="$version" -DNUMERIC="$numeric" -DPROGRAMS="$programs" -DOUTFILE="$setup" unbrowse.nsi)
test -s "$setup"
ls -l "$setup"
