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

echo "[packaged-kuri] npm pack dry run"
(
  cd packages/skill
  npm_config_cache="${TMPDIR:-/tmp}/unbrowse-npm-cache" npm pack --dry-run >/tmp/unbrowse-packaged-kuri-pack.log
)

echo "[packaged-kuri] single-binary smoke"
bash scripts/build-binaries.sh

echo "[packaged-kuri] ok"
