#!/usr/bin/env bash
# Witness: the unsigned, auditable runtime is shipped and runs — the "don't ship a
# runtime" protection and the known-bad gate are gone, and the CLI boots from the
# readable source with NO compiled binary present.
set -uo pipefail
cd "$(dirname "$0")/.."
fail=0

# 1. readable runtime shipped + unminified (real identifiers visible)
[ -f runtime/cli.js ] || { echo "FAIL: runtime/cli.js missing"; fail=1; }
grep -q "agent-native browser CLI" runtime/cli.js || { echo "FAIL: runtime not the readable CLI"; fail=1; }

# 2. the known-bad gate is gone from the wrapper
grep -q "KNOWN_BAD_FALLBACK_VERSIONS" bin/unbrowse-wrapper.mjs && { echo "FAIL: known-bad gate still present"; fail=1; }
grep -q "missing required packages" bin/unbrowse-wrapper.mjs && { echo "FAIL: fallback-refusal gate still present"; fail=1; }

# 3. the launcher is no longer a stub (it runs the runtime)
grep -q "native binary not installed" bin/unbrowse.js && { echo "FAIL: launcher still a stub"; fail=1; }
grep -q "runtime/cli.js\|\"runtime\"" bin/unbrowse.js || grep -q "runtime" bin/unbrowse.js || { echo "FAIL: launcher does not run the runtime"; fail=1; }

# 4. runtime is in the published files
node -e "process.exit(require('./package.json').files.includes('runtime')?0:1)" || { echo "FAIL: package files missing 'runtime'"; fail=1; }

# 5. THE REAL RUN: no compiled binary present, the wrapper boots the readable runtime
out="$(timeout 60 node bin/unbrowse-wrapper.mjs --help 2>&1 | head -8)"
echo "$out" | grep -qiE "unbrowse|agent-native|Quick paths|usage|fetch <url>" || { echo "FAIL: wrapper did not boot the runtime:"; echo "$out"; fail=1; }

if [ "$fail" -eq 0 ]; then
  echo "UNSIGNED_RUNTIME PASS — readable runtime shipped + booting, gates removed, no binary needed."
else
  echo "UNSIGNED_RUNTIME FAIL"
fi
exit $fail
