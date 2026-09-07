#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")/.."

echo "[packaged-kuri] runtime path + setup tests"
bun test tests/runtime-paths.test.ts tests/runtime-setup.test.ts

echo "[packaged-kuri] setup smoke"
# Three-verb collapse: setup is a `build` capability (`unbrowse build setup`);
# the flat `setup` token no longer routes.
UNBROWSE_DISABLE_AUTO_UPDATE=1 \
UNBROWSE_NON_INTERACTIVE=1 \
UNBROWSE_TOS_ACCEPTED=1 \
UNBROWSE_SKIP_WALLET_SETUP=1 \
bun run cli -- build setup --no-start --opencode off >/tmp/unbrowse-packaged-kuri-setup.log

# The remaining two steps both bottom out in scripts/build-release-manifest.ts,
# which REFUSES to build an unsigned release without the signing secret. That
# secret lives in GitHub Actions, by design — releases are signed in CI, never
# on a laptop. Wired unconditionally into .husky/pre-commit, that made this
# check impossible to pass on any developer machine: every commit touching
# src/kuri/, packages/skill/ or src/runtime/paths.ts died on
#   FATAL: UNBROWSE_RELEASE_MANIFEST_SIGNING_SECRET is not set
# leaving --no-verify as the only way through, which silently skips every OTHER
# pre-commit gate too.
#
# So: with the secret (CI) run the full pack + binary build unchanged. Without
# it, run the vendor assertions those steps wrap — the actual invariant is
# "the vendored kuri/utls binaries are present and correct", and that is
# checkable without signing anything. Degrade loudly, never silently.
SIGNING_SECRET="${UNBROWSE_RELEASE_MANIFEST_SIGNING_SECRET:-${RELEASE_MANIFEST_SIGNING_SECRET:-}}"

if [[ -z "$SIGNING_SECRET" ]]; then
  echo "[packaged-kuri] no release-manifest signing secret in env — CI-only."
  echo "[packaged-kuri] skipping 'npm pack' + single-binary build (both need a signed manifest)."
  echo "[packaged-kuri] running the vendor guards they wrap instead:"
  node packages/skill/scripts/assert-kuri-vendor.mjs
  node packages/skill/scripts/assert-utls-vendor.mjs
  echo "[packaged-kuri] ok (vendor guards only — full pack/binary check runs in CI)"
  exit 0
fi

echo "[packaged-kuri] npm pack dry run"
(
  cd packages/skill
  npm_config_cache="${TMPDIR:-/tmp}/unbrowse-npm-cache" npm pack --dry-run >/tmp/unbrowse-packaged-kuri-pack.log
)

echo "[packaged-kuri] single-binary smoke"
bash scripts/build-binaries.sh

echo "[packaged-kuri] ok"
