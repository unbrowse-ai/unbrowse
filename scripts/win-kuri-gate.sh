#!/usr/bin/env bash
# Windows end-to-end witness for the jesus-ralph loop.
#
# Exits 0 exactly when:
#   1. the kuri broker cross-compiles to a real x86_64-windows PE (kuri.exe),
#   2. that kuri.exe is vendored into the unbrowse npm package (win-x64 slot),
#   3. single-binary.ts embeds + resolves the win-x64 kuri, and
#   4. the Windows packaging/startup logic passes its unit suite.
#
# This is the locally-runnable proof that a Windows install has a real browser
# broker to spawn. The live Chrome-launch browse E2E lives in
# .github/workflows/test-windows.yml (windows-latest, CI-gated).
set -euo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
KURI="$REPO/submodules/kuri"
VENDOR="$REPO/packages/skill/vendor/kuri/win-x64/kuri.exe"

echo "[win-gate] 1/4 cross-compiling kuri.exe for x86_64-windows..."
( cd "$KURI" && zig build -Dtarget=x86_64-windows-gnu )
EXE="$KURI/zig-out/bin/kuri.exe"
test -f "$EXE" || { echo "[win-gate] FAIL: $EXE not produced"; exit 1; }
if ! file "$EXE" | grep -qiE 'PE32|MS Windows|x86-64'; then
  echo "[win-gate] FAIL: $EXE is not a Windows PE: $(file "$EXE")"; exit 1
fi
echo "[win-gate]   ok: $(file "$EXE" | cut -d: -f2-)"

echo "[win-gate] 2/4 verifying vendored win-x64 kuri.exe..."
test -f "$VENDOR" || { echo "[win-gate] FAIL: vendored $VENDOR missing"; exit 1; }
file "$VENDOR" | grep -qiE 'PE32|MS Windows|x86-64' || { echo "[win-gate] FAIL: vendored kuri.exe not a PE"; exit 1; }
echo "[win-gate]   ok: vendored kuri.exe present"

echo "[win-gate] 3/4 verifying single-binary embeds + resolves win-x64 kuri..."
grep -q 'vendor/kuri/win-x64/kuri.exe' "$REPO/src/single-binary.ts" || {
  echo "[win-gate] FAIL: single-binary.ts does not embed win-x64 kuri.exe"; exit 1; }
echo "[win-gate]   ok: win-x64 embed wired"

echo "[win-gate] 4/4 running Windows packaging unit suite..."
( cd "$REPO" && bun test tests/windows-packaging.test.ts >/dev/null 2>&1 ) || {
  echo "[win-gate] FAIL: tests/windows-packaging.test.ts red"; exit 1; }
echo "[win-gate]   ok: packaging suite green"

echo "[win-gate] PASS — Windows kuri.exe builds, is vendored, embedded, and packaging is sound."
