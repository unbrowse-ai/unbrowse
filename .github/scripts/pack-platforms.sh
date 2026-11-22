#!/bin/sh
# Packs each machine's programs for npm (`@unbrowse/darwin-arm64`, `@unbrowse/linux-x64`, `@unbrowse/win32-x64`, …) from
# the release's archives, and the browser add-on for each apart from them (`@unbrowse/browser-<machine>`: the browser
# program alone, which the node fetches when a goal first needs it), and writes the release's manifest: its version, the
# oldest version the network takes (unbrowse-node/MIN_VERSION), and each machine's package and browser package with
# the sha512 of its tarball, as npm will keep it. The
# release signs the manifest next (sign-manifest.mjs) and pack-sdks.sh puts it in `unbrowse`, where nodes read it to
# update (unbrowse-node/app/src/update.rs). Nothing from a package registry runs here: only npm pack and Python's own
# library.
#
#   usage: pack-platforms.sh <version> <programs-dir> <out-dir>
#
# <programs-dir> holds the release's archives: Unbrowse-<version>-macos-<arch>.zip (the app, which carries no browser)
# with unbrowse-<version>-macos-<arch>.tar.gz (the programs alone, the browser's among them),
# unbrowse-<version>-linux-<arch>.tar.gz and unbrowse-<version>-windows-x64.zip. A machine whose archive isn't there is
# left out.
set -eu

version=$1
programs=$(cd "$2" && pwd)
mkdir -p "$3"
out=$(cd "$3" && pwd)
root=$(git rev-parse --show-toplevel)

stage=$(mktemp -d)
trap 'rm -rf "$stage"' EXIT

# platform  archive  npm os/cpu  the archive the browser program comes from (- for the same one)
machines="darwin-arm64 Unbrowse-$version-macos-arm64.zip darwin arm64 unbrowse-$version-macos-arm64.tar.gz
linux-x64 unbrowse-$version-linux-x64.tar.gz linux x64 -
linux-arm64 unbrowse-$version-linux-arm64.tar.gz linux arm64 -
win32-x64 unbrowse-$version-windows-x64.zip win32 x64 -"

echo "$machines" | while read -r platform archive os cpu browser; do
  [ -f "$programs/$archive" ] || { echo "no $archive: $platform is left out"; continue; }
  dir=$stage/$platform
  mkdir -p "$dir/unpacked" "$dir/npm" "$dir/browser/bin"
  case $archive in
    *.zip) unzip -q "$programs/$archive" -d "$dir/unpacked" ;;
    *) tar -xzf "$programs/$archive" -C "$dir/unpacked" ;;
  esac
  x=""; [ "$os" = win32 ] && x=.exe
  pin=""
  if [ "$os" = darwin ]; then
    what=Unbrowse.app
    mv "$dir/unpacked/Unbrowse.app" "$dir/npm/Unbrowse.app"
    for p in unbrowse-window unbrowse-node unb; do test -x "$dir/npm/Unbrowse.app/Contents/MacOS/$p"; done
    # The app is sealed without the browser (package-macos.sh); its program, signed on its own, is in the tarball.
    test ! -e "$dir/npm/Unbrowse.app/Contents/MacOS/agent-browser"
    mkdir "$dir/alone"
    tar -xzf "$programs/$browser" -C "$dir/alone"
    mv "$dir/alone"/unbrowse-*/agent-browser "$dir/browser/bin/"
    about="Unbrowse.app for $os-$cpu: the window, the node and unb."
    # The Team ID the signing job read back from the app's signature (package-macos.sh), pinned in the package so the
    # CLI holds an Unbrowse.app installed elsewhere to it (pack-sdks.sh carries it into `unbrowse`). Ad hoc, none.
    teamfile=$programs/Unbrowse-$version-macos-$cpu.team
    if [ -f "$teamfile" ]; then
      team=$(tr -d ' \n' < "$teamfile")
      printf %s "$team" | grep -Eqx '[A-Z0-9]{10}' || { echo "pack-platforms.sh: $teamfile is not a Team ID"; exit 1; }
      pin="
  \"unbrowseAppTeam\": \"$team\","
    fi
  else
    what=bin
    mv "$dir/unpacked"/unbrowse-* "$dir/npm/bin"
    for p in unbrowse-window unbrowse-node unb agent-browser; do test -f "$dir/npm/bin/$p$x"; done
    # The browser program is an add-on, in a package of its own: the node's leaves it out.
    mv "$dir/npm/bin/agent-browser$x" "$dir/browser/bin/"
    about="The Unbrowse window, the node and unb for $os-$cpu."
  fi
  chmod 0755 "$dir/browser/bin/agent-browser$x"
  browser_sha256=$(sha256sum "$dir/browser/bin/agent-browser$x" | awk '{print $1}')
  libc=""; [ "$os" = linux ] && libc='
  "libc": ["glibc"],'
  # npm's trusted publishing takes a package only when its repository is the one the workflow runs in.
  repository=""; [ -n "${GITHUB_REPOSITORY:-}" ] && repository="
  \"repository\": { \"type\": \"git\", \"url\": \"git+${GITHUB_SERVER_URL:-https://github.com}/$GITHUB_REPOSITORY.git\" },"
  cp "$root/LICENSE" "$dir/npm/"
  cat > "$dir/npm/package.json" <<EOF
{
  "name": "@unbrowse/$platform",
  "version": "$version",
  "description": "$about Installed by the unbrowse package.",
  "license": "Apache-2.0",$repository
  "os": ["$os"],
  "cpu": ["$cpu"],$libc$pin
  "files": ["$what", "LICENSE"]
}
EOF
  (cd "$dir/npm" && npm pack --pack-destination "$out" >/dev/null)
  cp "$root/LICENSE" "$dir/browser/"
  cat > "$dir/browser/package.json" <<EOF
{
  "name": "@unbrowse/browser-$platform",
  "version": "$version",
  "description": "The Unbrowse node's browser program for $os-$cpu: an add-on the node fetches, checked against the release's signature, when a goal first needs a browser (unbrowse browser install). The unbrowse package never installs it.",
  "license": "Apache-2.0",$repository
  "os": ["$os"],
  "cpu": ["$cpu"],$libc
  "unbrowseBrowserSha256": "$browser_sha256",
  "files": ["bin", "LICENSE"]
}
EOF
  (cd "$dir/browser" && npm pack --pack-destination "$out" >/dev/null)
done
ls "$out"/unbrowse-*-"$version".tgz >/dev/null 2>&1 || { echo "pack-platforms.sh: no programs in $programs"; exit 1; }

min=$(tr -d ' \n' < "$root/unbrowse-node/MIN_VERSION")
python3 -I - "$version" "$min" "$out" <<'PY'
import base64, glob, hashlib, json, os, re, sys
version, min_version, out = sys.argv[1:]
platforms, browsers = {}, {}
for path in sorted(glob.glob(os.path.join(out, f"unbrowse-*-{version}.tgz"))):
    name = re.fullmatch(rf"unbrowse-(.+)-{re.escape(version)}\.tgz", os.path.basename(path)).group(1)
    digest = hashlib.sha512(open(path, "rb").read()).digest()
    package = {"name": f"@unbrowse/{name}", "integrity": "sha512-" + base64.b64encode(digest).decode()}
    # The browser add-on's packages are apart: a node from before reads only `platforms`, and installs those.
    if name.startswith("browser-"):
        browsers[name[len("browser-"):]] = package
    else:
        platforms[name] = package
with open(os.path.join(out, "manifest.json"), "w") as f:
    json.dump({"version": version, "min_version": min_version, "platforms": platforms, "browsers": browsers}, f, indent=2, sort_keys=True)
    f.write("\n")
PY
ls -1 "$out"
