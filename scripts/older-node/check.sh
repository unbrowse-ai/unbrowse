#!/bin/sh
# Reads a body with the route crate of an older node, as its store reads one (`store::a_body_that_reads`): a body that
# build does not read is no body, and the route stands as its graph there.
#   scripts/older-node/check.sh <base-commit> <body.json>...
# Builds the base's `unbrowse-route` as a scratch crate under $TMPDIR, in the node's own target folder (no new one).
set -eu
base=$1; shift
repo=$(git rev-parse --show-toplevel)
dir=${TMPDIR:-/tmp}/older-node-$base
rm -rf "$dir"; mkdir -p "$dir/route/src" "$dir/check/src"
for f in $(git -C "$repo" ls-tree --name-only "$base" unbrowse-node/crates/route/src/); do git -C "$repo" show "$base:$f" > "$dir/route/src/$(basename "$f")"; done
git -C "$repo" show "$base:unbrowse-node/crates/route/Cargo.toml" | sed -e 's/edition.workspace = true/edition = "2021"/' -e '/license.workspace/d' -e 's/version.workspace = true/version = "0.1.0"/' -e '/^\[lints\]/,$d' > "$dir/route/Cargo.toml"
git -C "$repo" show "$base:unbrowse-node/Cargo.lock" > "$dir/Cargo.lock"
printf '[workspace]\nmembers = ["route", "check"]\nresolver = "2"\n' > "$dir/Cargo.toml"
printf '[package]\nname = "check"\nversion = "0.1.0"\nedition = "2021"\n[dependencies]\nunbrowse-route = { path = "../route" }\nserde_json = { version = "1", features = ["preserve_order"] }\n' > "$dir/check/Cargo.toml"
cp "$repo/scripts/older-node/main.rs" "$dir/check/src/main.rs"
abs=""; for b in "$@"; do abs="$abs $(cd "$(dirname "$b")" && pwd)/$(basename "$b")"; done
cd "$dir" && CARGO_TARGET_DIR="$repo/unbrowse-node/target/older-node" cargo run -q -p check -- $abs
