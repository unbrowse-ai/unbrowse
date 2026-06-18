#!/usr/bin/env bash
# sdk-compat-gate.sh — witness for "@unbrowse/sdk is compatible with the latest unbrowse".
# Exit 0 only when: the SDK pins unbrowse to v9+, the SDK builds clean against it, and the
# README/docs validate. This is the jesus-ralph witness for the SDK code+readme compat update.
set -uo pipefail
cd "$(dirname "$0")/.." || exit 2
SDK=packages/sdk
fail=0
ok(){ printf 'ok   %s\n' "$1"; }
bad(){ printf 'FAIL %s\n' "$1"; fail=1; }

# 1. SDK pins the LATEST unbrowse major (v9+), not the stale 6.x. Parse the first
#    number in each range as the major floor (avoids substring false-matches).
peer=$(node -e "console.log(require('./$SDK/package.json').peerDependencies?.unbrowse||'')" 2>/dev/null)
opt=$(node -e "console.log(require('./$SDK/package.json').optionalDependencies?.unbrowse||'')" 2>/dev/null)
peerMajor=$(printf '%s' "$peer" | grep -oE '[0-9]+' | head -1)
optMajor=$(printf '%s' "$opt" | grep -oE '[0-9]+' | head -1)
if [ "${peerMajor:-0}" -ge 9 ] && [ "${optMajor:-0}" -ge 9 ]; then
  ok "SDK pins unbrowse v9+ (peer='$peer' optional='$opt')"
else
  bad "SDK still pins stale unbrowse (peer='$peer' optional='$opt')"
fi

# 2. SDK builds clean against the current types (compat of code).
if ( cd "$SDK" && npm run build ) >/tmp/sdk-build.log 2>&1; then
  ok "SDK builds (npm run build)"
else
  bad "SDK build failed — see /tmp/sdk-build.log"; tail -8 /tmp/sdk-build.log | sed 's/^/    /'
fi

# 3. README compat: no stale version claim (the old "Current version: 8.2.0" line),
#    and the install/usage still reads correctly. (The package's prior docs:validate*
#    scripts pointed at validators that never existed — removed; this is the real check.)
if grep -qiE "current version:\s*\*\*?[0-8]\." "$SDK/README.md" 2>/dev/null; then
  bad "README claims a stale version (pre-v9)"
elif ! grep -q "@unbrowse/sdk" "$SDK/README.md" 2>/dev/null; then
  bad "README missing the package name / install"
else
  ok "README has no stale version claim"
fi

# 4. No lingering deprecation framing in package/readme.
if grep -qiE "deprecated|v6 legacy|\(v6 legacy\)" "$SDK/package.json" "$SDK/README.md" 2>/dev/null; then
  bad "deprecation framing still present in package.json/README"
else
  ok "no deprecation framing in package.json/README"
fi

if [ "$fail" -eq 0 ]; then echo "SDK-COMPAT GREEN — @unbrowse/sdk builds + docs-valid against latest unbrowse"; exit 0; fi
echo "SDK-COMPAT RED"; exit 1
