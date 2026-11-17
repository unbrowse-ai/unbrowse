#!/bin/sh
# Packs a Linux or Windows release from the release builds: the window, the node, `unb` and the browser in one folder
# (each looks for the next beside itself), as `unbrowse-<version>-<os>-<arch>.tar.gz` on Linux and `.zip` on Windows.
# A Mac's release is Unbrowse.app instead (package-macos.sh).
#
#   usage: package-programs.sh <version> <platform> <out-dir>
#
# <platform> is linux-x64, linux-arm64 or win32-x64. Builds first: `cargo build --release` in unbrowse-node and
# unbrowse-browser/cli, and `zig build -Doptimize=ReleaseSafe` in unbrowse-node/window.
set -eu

version=$1
platform=$2
mkdir -p "$3"
out=$(cd "$3" && pwd)
root=$(git rev-parse --show-toplevel)
case $platform in
  linux-*) x="" name="unbrowse-$version-$platform" ;;
  win32-*) x=".exe" name="unbrowse-$version-windows-${platform#win32-}" ;;
  *) echo "package-programs.sh: $platform isn't Linux or Windows" >&2; exit 1 ;;
esac

stage=$(mktemp -d)
trap 'rm -rf "$stage"' EXIT
mkdir "$stage/$name"
for p in "unbrowse-node/target/release/unbrowse-node" "unbrowse-node/target/release/unb" \
  "unbrowse-browser/cli/target/release/agent-browser" "unbrowse-node/window/zig-out/bin/unbrowse-window"; do
  cp "$root/$p$x" "$stage/$name/"
done
chmod 0755 "$stage/$name"/*
# The folder says how to start it: someone who downloads it has only what is inside.
cat > "$stage/$name/README.md" <<README
# Unbrowse $version

Four programs. Each looks for the next beside itself, so keep them in this folder.

| Program | What it is |
|---|---|
| \`unbrowse-node$x\` | The node: the agent API and MCP on \`127.0.0.1:7788\`, the route learner, the vault and the wallet |
| \`unb$x\` | The node from a shell, for agents and scripts |
| \`agent-browser$x\` | The browser the node learns from, also usable by hand |
| \`unbrowse-window$x\` | The window: watches the node, makes agent keys, approves payments |

## Start

The node runs a local chain for payments, so it needs Foundry's Anvil first (https://getfoundry.sh):

    curl -L https://foundry.paradigm.xyz | bash && foundryup

Then:

    ./unbrowse-node$x       # the node, headless; keeps everything under ~/.unbrowse
    ./unbrowse-window$x     # optional: the window (on Linux it needs GTK 4 or 3)

The root key lives in the system's keystore (the Secret Service on Linux, the Credential Manager on Windows); on a
Linux machine with no desktop session it is \`~/.unbrowse/root.key\`, readable by its user alone. The node browses in
Chrome or another Chromium browser here, and downloads Chrome for Testing the first time a goal needs a browser and
there is none (\`unbrowse-node$x browser install\` does it now). Everything else runs without a browser.

## Connect an agent

    ./unbrowse-node$x agent new my-agent   # an agent key; prints its setup once
    ./unb$x connect                         # registers agent 0 with Claude Code

Or make the key in the window (Wallet, New agent key). Any MCP client can start \`unb mcp\`, with the agent's token in
UNBROWSE_AGENT_TOKEN: it signs each request with the token, which never goes over the wire.

## Updates

A release build keeps itself up to date. Releases: https://github.com/unbrowse-ai/unbrowse-core/releases
README

case $platform in
  win32-*) (cd "$stage" && 7z a -tzip -bso0 "$out/$name.zip" "$name") ;;
  *) tar -czf "$out/$name.tar.gz" -C "$stage" "$name" ;;
esac
ls -1 "$out"
