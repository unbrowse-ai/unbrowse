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
# Signed ad hoc unless MACOS_SIGN_IDENTITY names a Developer ID Application identity in the keychain (a production
# release refuses to run without one: release.yml); then the app is
# signed with it under the hardened runtime, and the disk image is notarized and the ticket stapled to it and to the
# app, with the first of these that is set:
#   - APPLE_API_KEY (an App Store Connect team key's .p8, as its text or base64), APPLE_API_KEY_ID and APPLE_API_ISSUER:
#     a key of the team's, not a person's password, revoked in App Store Connect without touching anyone's Apple ID;
#   - NOTARY_PROFILE: a profile `xcrun notarytool store-credentials` saved in this Mac's keychain (a build on the
#     owner's own machine);
#   - APPLE_ID, APPLE_TEAM_ID and APPLE_APP_PASSWORD (an app-specific password).
# Signed with an identity, it also writes Unbrowse-<version>-macos-<arch>.team: the Team ID the app's signature names.
#
# CHANNEL=production refuses to finish without notarization: a disk image that isn't notarized can't be opened by a
# click on macOS 15, so the owner would need System Settings or a terminal before the app's first screen. The stapled
# ticket is checked on the image and the app (`stapler validate`). MACOS_ALLOW_UNNOTARIZED=true lets a production
# release through un-notarized, with a warning, for when the notary secrets aren't set yet.
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
# Each program under a fixed identifier, the bundle's for the window: codesign otherwise names a program after its
# linker's hash (unbrowse-node-5555…), a new name every build, and the Keychain's rule for the node's key names the
# program, so a release that renamed it would lose the key it made (unbrowse-core#630).
for p in "$app"/Contents/MacOS/*; do
  case $(basename "$p") in
    unbrowse-window) id=network.unbrowse.window ;;
    *) id=$(basename "$p") ;;
  esac
  sign --identifier "$id" "$p"
done
sign "$app"
codesign --verify --strict "$app"
# The browser program, signed the same way on its own, for the tarball and the add-on.
install -m 0755 "$browser" "$stage/agent-browser"
sign --identifier agent-browser "$stage/agent-browser"

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
  notary=
  if [ -n "${APPLE_API_KEY:-}" ] && [ -n "${APPLE_API_KEY_ID:-}" ] && [ -n "${APPLE_API_ISSUER:-}" ]; then
    # The key's file is this run's alone, and gone with the stage.
    key=$stage/AuthKey_$APPLE_API_KEY_ID.p8
    (umask 077; case "$APPLE_API_KEY" in *"BEGIN PRIVATE KEY"*) printf '%s\n' "$APPLE_API_KEY" ;; *) printf %s "$APPLE_API_KEY" | base64 --decode ;; esac > "$key")
    grep -q "BEGIN PRIVATE KEY" "$key" || { echo "package-macos.sh: APPLE_API_KEY is neither a .p8 nor one in base64"; exit 1; }
    notary=api
  elif [ -n "${NOTARY_PROFILE:-}" ]; then
    notary=profile
  elif [ -n "${APPLE_ID:-}" ] && [ -n "${APPLE_TEAM_ID:-}" ] && [ -n "${APPLE_APP_PASSWORD:-}" ]; then
    notary=password
  fi
  if [ -n "$notary" ]; then
    case $notary in
      api) xcrun notarytool submit "$dmg" --key "$key" --key-id "$APPLE_API_KEY_ID" --issuer "$APPLE_API_ISSUER" --wait --output-format json > "$stage/notary.json" ;;
      profile) xcrun notarytool submit "$dmg" --keychain-profile "$NOTARY_PROFILE" --wait --output-format json > "$stage/notary.json" ;;
      password) xcrun notarytool submit "$dmg" --apple-id "$APPLE_ID" --team-id "$APPLE_TEAM_ID" --password "$APPLE_APP_PASSWORD" --wait --output-format json > "$stage/notary.json" ;;
    esac
    cat "$stage/notary.json"; echo
    # `--wait` exits 0 for a submission Apple rejected: only "Accepted" is notarized. A rejection's log says why.
    if ! grep -q '"status" *: *"Accepted"' "$stage/notary.json"; then
      id=$(sed -n 's/.*"id" *: *"\([^"]*\)".*/\1/p' "$stage/notary.json" | head -n 1)
      case $notary in
        api) xcrun notarytool log "$id" --key "$key" --key-id "$APPLE_API_KEY_ID" --issuer "$APPLE_API_ISSUER" || true ;;
        profile) xcrun notarytool log "$id" --keychain-profile "$NOTARY_PROFILE" || true ;;
        password) xcrun notarytool log "$id" --apple-id "$APPLE_ID" --team-id "$APPLE_TEAM_ID" --password "$APPLE_APP_PASSWORD" || true ;;
      esac
      echo "package-macos.sh: Apple didn't accept the disk image for notarization"
      exit 1
    fi
    # The service tickets the image and the code inside it: the image carries its ticket, and so does the app the zip
    # packs next. A copy dragged out of the image is checked online on its first launch.
    xcrun stapler staple "$dmg"
    xcrun stapler staple "$app"
    xcrun stapler validate "$dmg"
    xcrun stapler validate "$app"
    spctl --assess --type execute --verbose "$app"
    notarized=1
  else
    echo "Signed with $identity but not notarized: set APPLE_API_KEY, APPLE_API_KEY_ID and APPLE_API_ISSUER (or NOTARY_PROFILE, or APPLE_ID, APPLE_TEAM_ID and APPLE_APP_PASSWORD)"
  fi
fi
if [ "${CHANNEL:-}" = production ] && [ -z "${notarized:-}" ]; then
  if [ "${MACOS_ALLOW_UNNOTARIZED:-}" = true ]; then
    echo "::warning::this production Mac app isn't notarized (MACOS_ALLOW_UNNOTARIZED=true): macOS blocks its first launch until the owner allows it in System Settings"
  else
    echo "::error::a production Mac app must be notarized: set APPLE_API_KEY, APPLE_API_KEY_ID and APPLE_API_ISSUER (an App Store Connect team key) in the release environment, or the repository variable MACOS_ALLOW_UNNOTARIZED=true to release it un-notarized"
    exit 1
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
