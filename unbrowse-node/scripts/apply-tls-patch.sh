#!/bin/sh
# Vendor btls-sys with the Chrome-handshake patches and enable them.
#
# chrome-ext.patch adds the two extensions Chrome sends that BoringSSL does not
# (0x12e0, 0xca34), whose bytes were captured from a live browser ClientHello
# (crates/learn/assets/chrome-clienthello/). chrome-pss.patch adds the three
# RSA-PSS-PSS signature schemes Chrome offers (0x0904..0x0906); without them the
# transport's JA4 is not the minting browser's, and a door-bound clearance is
# refused on replay. chrome-grease-sigalg.patch prepends the GREASE signature
# algorithm Chrome sends ahead of its real ones (peetprint's `GREASE-2308-…`);
# without it peetprint differs from the browser's even when JA4 matches. A door
# that judges the handshake expects all three.
#
# Idempotent: safe to re-run.
set -e
# Windows' Git Bash names them python and sha256sum.
python3=$(command -v python3 || command -v python)
sha256() { if command -v sha256sum >/dev/null; then sha256sum "$1"; else shasum -a 256 "$1"; fi; }
here=$(cd "$(dirname "$0")/.." && pwd)
version=0.5.6
src=$(ls -d "${CARGO_HOME:-$HOME/.cargo}"/registry/src/*/btls-sys-$version 2>/dev/null | head -1)
if [ -z "$src" ]; then
    # A fresh clone (or CI) has no registry copy, and cargo can't fetch one while the workspace points at the vendored
    # path this script makes. Fetch the crate from crates.io and check it against the index's checksum, as cargo would.
    tmp=$(mktemp -d)
    trap 'rm -rf "$tmp"' EXIT
    curl -fsSL "https://static.crates.io/crates/btls-sys/btls-sys-$version.crate" -o "$tmp/btls-sys.crate"
    want=$(curl -fsSL "https://index.crates.io/bt/ls/btls-sys" | "$python3" -c '
import json, sys
v = sys.argv[1]
print(next(e["cksum"] for e in map(json.loads, sys.stdin) if e["vers"] == v))' "$version")
    got=$(sha256 "$tmp/btls-sys.crate" | cut -d" " -f1)
    [ "$got" = "$want" ] || { echo "btls-sys-$version.crate checksum $got isn't crates.io's $want"; exit 1; }
    tar -xzf "$tmp/btls-sys.crate" -C "$tmp"
    src="$tmp/btls-sys-$version"
fi

rm -rf "$here/vendor/btls-sys"
mkdir -p "$here/vendor"
cp -R "$src" "$here/vendor/btls-sys"
chmod -R u+w "$here/vendor/btls-sys"
cp "$here/crates/learn/assets/chrome-clienthello/chrome-ext.patch" "$here/vendor/btls-sys/patches/"
cp "$here/crates/learn/assets/chrome-clienthello/chrome-pss.patch" "$here/vendor/btls-sys/patches/"
cp "$here/crates/learn/assets/chrome-clienthello/chrome-grease-sigalg.patch" "$here/vendor/btls-sys/patches/"

# Register the patches right after the fork's own boringssl.patch.
"$python3" - "$here/vendor/btls-sys/build/main.rs" <<'PY'
import sys
p=sys.argv[1]
s=open(p).read()
old='    apply_patch(config, "boringssl.patch")?;'
new=('    apply_patch(config, "boringssl.patch")?;\n'
     '    println!("cargo:warning=applying chrome extensions patch to boringssl");\n'
     '    apply_patch(config, "chrome-ext.patch")?;')
if 'chrome-ext.patch' not in s:
    assert old in s
    s = s.replace(old,new,1)
if 'chrome-pss.patch' not in s:
    anchor = '    apply_patch(config, "chrome-ext.patch")?;'
    assert anchor in s
    s = s.replace(anchor, anchor + '\n'
        '    println!("cargo:warning=applying chrome pss sigalgs patch to boringssl");\n'
        '    apply_patch(config, "chrome-pss.patch")?;', 1)
if 'chrome-grease-sigalg.patch' not in s:
    anchor = '    apply_patch(config, "chrome-pss.patch")?;'
    assert anchor in s
    s = s.replace(anchor, anchor + '\n'
        '    println!("cargo:warning=applying chrome grease sigalg patch to boringssl");\n'
        '    apply_patch(config, "chrome-grease-sigalg.patch")?;', 1)
open(p,'w').write(s)
PY

# Point the workspace at the vendored fork.
"$python3" - "$here/Cargo.toml" <<'PY'
import sys
p=sys.argv[1]
s=open(p).read()
if '[patch.crates-io]' not in s:
    s += '\n[patch.crates-io]\nbtls-sys = { path = "vendor/btls-sys" }\n'
    open(p,'w').write(s)
PY
echo "vendored btls-sys with the chrome-extensions patch; rebuild to take effect"
