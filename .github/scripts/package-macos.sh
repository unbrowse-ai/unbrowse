#!/bin/sh
# Packs the macOS release from the release builds: Unbrowse.app with the node and `unb` in Contents/MacOS beside the
# window (each one looks for the next beside itself), as a disk image to drag into Applications and as a zip, and the
# node, `unb` and the browser program as a tarball, for a machine that runs the node without the window. The app carries
# no browser: the node fetches it, as an add-on, when a goal first needs one (pack-platforms.sh packs it from the
# tarball, signed here like the app's programs).
#
#   usage: package-macos.sh <version> <out-dir>
#
# Builds first: `cargo build --release` in unbrowse-node and unbrowse-browser/cli, and `zig build app -Dversion=<version>`
# in unbrowse-node/window.
#
# Signed ad hoc unless MACOS_SIGN_IDENTITY names a Developer ID Application identity in the keychain; then the app is
# signed with it under the hardened runtime, and with APPLE_ID, APPLE_TEAM_ID and APPLE_APP_PASSWORD (an app-specific
# password) the disk image is notarized and the ticket stapled to it and to the app. Signed with an identity, it also
# writes Unbrowse-<version>-macos-<arch>.team: the Team ID the app's signature names.
set -eu

version=$1
out=$2
arch=$(uname -m)
[ "$arch" = x86_64 ] && arch=x64
root=$(git rev-parse --show-toplevel)
programs="$root/unbrowse-node/target/release/unbrowse-node $root/unbrowse-node/target/release/unb"
browser="$root/unbrowse-browser/cli/target/release/agent-browser"
identity=${MACOS_SIGN_IDENTITY:-}

stage=$(mktemp -d)
trap 'rm -rf "$stage"' EXIT
app=$stage/Unbrowse.app
ditto "$root/unbrowse-node/window/zig-out/Unbrowse.app" "$app"
for p in $programs; do install -m 0755 "$p" "$app/Contents/MacOS/"; done

# Each program, then the bundle that seals them and its Resources. Ad hoc, a downloaded copy is quarantined until its
# owner opens it once by hand (the release notes say how).
if [ -n "$identity" ]; then
  sign() { codesign --force --options runtime --timestamp --sign "$identity" "$@"; }
else
  sign() { codesign --force --sign - "$@"; }
fi
for p in "$app"/Contents/MacOS/*; do sign "$p"; done
sign "$app"
codesign --verify --strict "$app"
# The browser program, signed the same way on its own, for the tarball and the add-on.
install -m 0755 "$browser" "$stage/agent-browser"
sign "$stage/agent-browser"

mkdir -p "$out"
dmg=$out/Unbrowse-$version-macos-$arch.dmg

# The disk image: the app beside a link to /Applications, to drag it onto. hdiutil on a CI runner sometimes finds the
# device busy, so it gets three tries.
volume=$stage/volume
mkdir "$volume"
ditto "$app" "$volume/Unbrowse.app"
ln -s /Applications "$volume/Applications"
made=""
for try in 1 2 3; do
  hdiutil create -volname Unbrowse -srcfolder "$volume" -fs HFS+ -format UDZO -ov "$dmg" && { made=1; break; }
  echo "hdiutil create failed (try $try)"
  sleep 5
done
[ -n "$made" ] || { echo "package-macos.sh: no disk image"; exit 1; }

if [ -n "$identity" ]; then
  codesign --force --timestamp --sign "$identity" "$dmg"
  if [ -n "${APPLE_ID:-}" ] && [ -n "${APPLE_TEAM_ID:-}" ] && [ -n "${APPLE_APP_PASSWORD:-}" ]; then
    xcrun notarytool submit "$dmg" --apple-id "$APPLE_ID" --team-id "$APPLE_TEAM_ID" --password "$APPLE_APP_PASSWORD" --wait
    # The service tickets the image and the code inside it: the image carries its ticket, and so does the app the zip
    # packs next. A copy dragged out of the image is checked online on its first launch.
    xcrun stapler staple "$dmg"
    xcrun stapler staple "$app"
    spctl --assess --type execute --verbose "$app"
  else
    echo "Signed with $identity but not notarized: APPLE_ID, APPLE_TEAM_ID or APPLE_APP_PASSWORD isn't set"
  fi
fi
hdiutil verify "$dmg"

ditto -c -k --keepParent "$app" "$out/Unbrowse-$version-macos-$arch.zip"

# The Team ID the app is signed by, read back from its own signature, for the npm packages to pin (pack-platforms.sh):
# the CLI runs an Unbrowse.app installed elsewhere only when it is signed by this team. Signed ad hoc there is none.
if [ -n "$identity" ]; then
  team=$(codesign -dv "$app" 2>&1 | sed -n 's/^TeamIdentifier=//p')
  printf %s "$team" | grep -Eqx '[A-Z0-9]{10}' || { echo "package-macos.sh: signed with $identity but no Team ID in the signature"; exit 1; }
  printf '%s\n' "$team" > "$out/Unbrowse-$version-macos-$arch.team"
fi

cli=$stage/unbrowse-$version-macos-$arch
mkdir "$cli"
for p in unbrowse-node unb; do cp -p "$app/Contents/MacOS/$p" "$cli/"; done
cp -p "$stage/agent-browser" "$cli/"
tar -czf "$out/unbrowse-$version-macos-$arch.tar.gz" -C "$stage" "$(basename "$cli")"
