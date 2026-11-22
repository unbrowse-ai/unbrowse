#!/bin/sh
# Packs a Debian package (Debian, Ubuntu and their family), unbrowse_<version>_<arch>.deb, from the release's
# unbrowse-<version>-linux-<arch>.tar.gz (package-programs.sh): the four programs in /opt/unbrowse (each looks for the
# next beside itself), `unbrowse-node`, `unb` and `unbrowse-window` on the PATH, and the window in the desktop's app
# menu. Runs anywhere dpkg-deb does.
#
#   usage: package-linux-deb.sh <version> <programs tarball> <out-dir>
set -eu

version=$1
tarball=$2
mkdir -p "$3"
out=$(cd "$3" && pwd)
root=$(git rev-parse --show-toplevel)
case $tarball in
  *-linux-x64.tar.gz) arch=amd64 ;;
  *-linux-arm64.tar.gz) arch=arm64 ;;
  *) echo "package-linux-deb.sh: $tarball isn't a linux-x64 or linux-arm64 tarball" >&2; exit 1 ;;
esac
# Debian orders 1.2.0~pre before 1.2.0, as semver orders 1.2.0-pre.
debversion=$(printf %s "$version" | tr - '~')

stage=$(mktemp -d)
trap 'rm -rf "$stage"' EXIT
mkdir "$stage/tar"
tar -xzf "$tarball" -C "$stage/tar"
programs=$(find "$stage/tar" -mindepth 1 -maxdepth 1 -type d | head -n 1)
pkg=$stage/pkg
mkdir -p "$pkg/DEBIAN" "$pkg/opt/unbrowse" "$pkg/usr/bin" "$pkg/usr/share/applications" \
  "$pkg/usr/share/icons/hicolor/1024x1024/apps" "$pkg/usr/share/doc/unbrowse"
for p in unbrowse-node unb agent-browser unbrowse-window; do
  test -f "$programs/$p" || { echo "package-linux-deb.sh: $tarball has no $p" >&2; exit 1; }
  install -m 0755 "$programs/$p" "$pkg/opt/unbrowse/$p"
done
install -m 0644 "$programs/README.md" "$pkg/usr/share/doc/unbrowse/README.md"
# agent-browser stays in /opt/unbrowse: the node finds it there, and a PATH entry would shadow another agent-browser.
for p in unbrowse-node unb unbrowse-window; do ln -s "/opt/unbrowse/$p" "$pkg/usr/bin/$p"; done
install -m 0644 "$root/.github/installers/linux/unbrowse.desktop" "$pkg/usr/share/applications/unbrowse.desktop"
install -m 0644 "$root/unbrowse-node/app/icons/icon.png" "$pkg/usr/share/icons/hicolor/1024x1024/apps/unbrowse.png"

size=$(du -sk "$pkg" | cut -f1)
# Recommends, which apt installs with the package: GTK 4 for the window, libsecret for the node's key in the desktop's
# keyring, and zenity or kdialog, the dialog the node asks its owner's yes in (a remote key, an agent's grant): without
# one, those steps can only be done from a terminal.
cat > "$pkg/DEBIAN/control" <<CONTROL
Package: unbrowse
Version: $debversion
Architecture: $arch
Maintainer: Unbrowse <hello@unbrowse.ai>
Installed-Size: $size
Depends: libc6 (>= 2.35)
Recommends: libgtk-4-1, libsecret-1-0, zenity | kdialog
Section: net
Priority: optional
Homepage: https://unbrowse.ai
Description: Unbrowse node, window and browser
 The node serves the agent API and MCP on 127.0.0.1:7788 and learns each
 site's own API calls; the window watches the node, makes agent keys and
 approves payments. Start Unbrowse from the app menu, or run unbrowse-node.
CONTROL

# The file keeps the release's own version: GitHub renames a "~" in a release asset's name.
deb="$out/unbrowse_${version}_$arch.deb"
dpkg-deb --root-owner-group --build "$pkg" "$deb" >/dev/null
dpkg-deb --info "$deb" >/dev/null
dpkg-deb --contents "$deb"
ls -l "$deb"
