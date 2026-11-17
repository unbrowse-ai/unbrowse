#!/bin/sh
# Draws every Unbrowse icon from the U-magnet (icon.svg, the brand's favicon.svg from unbrowse-landing) with
# render.swift: the macOS app icon (AppIcon.icns, icon.png).
# Needs only Swift and the system's iconutil. Run it again whenever the mark changes.
set -e
here=$(cd "$(dirname "$0")" && pwd)
work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT
swiftc -O "$here/render.swift" -o "$work/render"
r="$work/render"

# macOS: Apple's icon grid (an 824-pixel tile in a 1024 canvas), every size the Dock and Finder ask for.
set="$work/AppIcon.iconset"
mkdir "$set"
for s in 16 32 128 256 512; do
    "$r" macos "$s" "$set/icon_${s}x${s}.png"
    "$r" macos "$((s * 2))" "$set/icon_${s}x${s}@2x.png"
done
iconutil -c icns "$set" -o "$here/AppIcon.icns"
"$r" macos 1024 "$here/icon.png"

echo "icons drawn: $here/AppIcon.icns, $here/icon.png"
