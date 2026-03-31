#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")/.."

echo "[packaged-kuri] runtime path + setup tests"
bun test tests/runtime-paths.test.ts tests/runtime-setup.test.ts

echo "[packaged-kuri] setup smoke"
UNBROWSE_DISABLE_AUTO_UPDATE=1 bun run cli -- setup --no-start >/tmp/unbrowse-packaged-kuri-setup.log

echo "[packaged-kuri] npm pack dry run"
(
  cd packages/skill
  npm pack --dry-run >/tmp/unbrowse-packaged-kuri-pack.log
)

echo "[packaged-kuri] ok"
