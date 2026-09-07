#!/usr/bin/env bash
# vendor.sh — populate vendor/obscura/<target>/ with the two binaries the
# Chrome-free backend needs, so a packaged unbrowse install resolves them with
# no env override.
#
#   obscura          the shipped CLI/MCP engine — fetched from the GitHub release
#   obscura-capture  the route-learning sidecar — built from ./ (this crate)
#
# The layout matches src/obscura/resolve-bin.ts obscuraVendorCandidatePaths:
#   <repo>/vendor/obscura/<target>/{obscura,obscura-capture}
#   packages/skill/vendor/obscura/<target>/{obscura,obscura-capture}   (mirror)
# where <target> is one of: linux-x64 linux-arm64 darwin-x64 darwin-arm64 win-x64.
#
# Usage:  bash native/obscura-capture/vendor.sh [--tag vX.Y.Z] [--mirror-skill]
set -euo pipefail

OBSCURA_TAG="v0.1.11"          # pin; the sidecar is built against this crate tag
MIRROR_SKILL=0
while [[ $# -gt 0 ]]; do
  case "$1" in
    --tag) OBSCURA_TAG="$2"; shift 2 ;;
    --mirror-skill) MIRROR_SKILL=1; shift ;;
    -h|--help) sed -n '2,20p' "$0"; exit 0 ;;
    *) echo "unknown arg: $1" >&2; exit 2 ;;
  esac
done

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
repo="$(cd "$here/../.." && pwd)"

# --- resolve target key + release asset from uname (node platform/arch names) ---
os="$(uname -s)"; arch="$(uname -m)"
case "$os" in Linux) node_os="linux";; Darwin) node_os="darwin";; *) echo "unsupported OS: $os" >&2; exit 1;; esac
case "$arch" in x86_64|amd64) node_arch="x64"; rel_arch="x86_64";; aarch64|arm64) node_arch="arm64"; rel_arch="aarch64";; *) echo "unsupported arch: $arch" >&2; exit 1;; esac
target="${node_os}-${node_arch}"
rel_os="$node_os"   # obscura release names use linux/macos
[[ "$node_os" == "darwin" ]] && rel_os="macos"
asset="obscura-${rel_arch}-${rel_os}-stealth.tar.gz"

dest="$repo/vendor/obscura/$target"
mkdir -p "$dest"
echo "vendor target: $target  ->  $dest"

# --- 1. fetch the prebuilt obscura CLI (+ worker) from the GitHub release ---
tmp="$(mktemp -d)"; trap 'rm -rf "$tmp"' EXIT
echo "fetching $asset @ $OBSCURA_TAG ..."
if command -v gh >/dev/null 2>&1; then
  gh release download "$OBSCURA_TAG" -R h4ckf0r0day/obscura -p "$asset" -D "$tmp" --clobber
else
  curl -fsSL -o "$tmp/$asset" \
    "https://github.com/h4ckf0r0day/obscura/releases/download/${OBSCURA_TAG}/${asset}"
fi
tar xzf "$tmp/$asset" -C "$tmp"
cp "$tmp/obscura" "$dest/obscura"
[[ -f "$tmp/obscura-worker" ]] && cp "$tmp/obscura-worker" "$dest/obscura-worker"
chmod +x "$dest/obscura" "$dest/obscura-worker" 2>/dev/null || true

# --- 2. build the sidecar from this crate (prebuilt V8, no ninja) ---
echo "building obscura-capture sidecar ..."
( cd "$here" && cargo build --release )
cp "$here/target/release/obscura-capture" "$dest/obscura-capture"
chmod +x "$dest/obscura-capture"

# --- 3. optional mirror into the packaged-skill vendor tree ---
if [[ "$MIRROR_SKILL" == "1" ]]; then
  skill_dest="$repo/packages/skill/vendor/obscura/$target"
  mkdir -p "$skill_dest"
  cp "$dest/obscura" "$dest/obscura-capture" "$skill_dest/"
  [[ -f "$dest/obscura-worker" ]] && cp "$dest/obscura-worker" "$skill_dest/"
  echo "mirrored to $skill_dest"
fi

echo "vendored: $(ls -1 "$dest" | tr '\n' ' ')"
echo "resolve-bin.ts will now find these with no env override."
