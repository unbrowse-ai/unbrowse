#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")/.."

ROOT_DIR="$(pwd)"
TMP_ROOT="$(mktemp -d /tmp/unbrowse-release-local.XXXXXX)"

cleanup() {
  rm -rf "$TMP_ROOT"
}
trap cleanup EXIT

log() {
  printf '\n[%s] %s\n' "release:local" "$*"
}

run() {
  log "$*"
  "$@"
}

run_in_dir() {
  local dir="$1"
  shift
  log "cd $dir && $*"
  (
    cd "$dir"
    "$@"
  )
}

build_python_package() {
  local dir="$1"
  local name="$2"
  local venv_dir="$TMP_ROOT/$name-venv"
  local build_dir="$TMP_ROOT/$name-build"
  log "python build $dir"
  (
    mkdir -p "$build_dir"
    cp -R "$dir"/. "$build_dir"/
    rm -rf "$build_dir/dist" "$build_dir/build" "$build_dir"/*.egg-info
    cd "$build_dir"
    python3 -m venv "$venv_dir"
    # shellcheck disable=SC1090
    source "$venv_dir/bin/activate"
    pip install -U pip build
    python -m build
  )
}

smoke_install_cli() {
  local tarball="$1"
  local smoke_dir="$TMP_ROOT/cli-smoke"
  mkdir -p "$smoke_dir"

  log "smoke install $tarball"
  (
    cd "$smoke_dir"
    npm init -y >/dev/null
    npm install --omit=optional "$tarball"
    npx unbrowse --help
  )
}

packaged_cli_tarball() {
  local raw
  raw="$(cd "$ROOT_DIR/packages/skill" && npm pack --json --pack-destination "$TMP_ROOT" 2>&1)"
  printf '%s\n' "$raw" >&2
  node -e '
const raw = process.argv[1];
const lines = raw.split(/\r?\n/);
const jsonStartLine = lines.findIndex((line) => /^\[\s*$/.test(line));
if (jsonStartLine === -1) {
  throw new Error("npm pack --json missing JSON payload");
}
const payload = JSON.parse(lines.slice(jsonStartLine).join("\n"));
if (!Array.isArray(payload) || payload.length === 0 || !payload[0].filename) {
  throw new Error("npm pack --json missing filename");
}
process.stdout.write(payload[0].filename);
' "$raw"
}

run git submodule sync --recursive
run git submodule update --init --remote submodules/kuri
run bun install --frozen-lockfile
run bun scripts/sync-skill-md.ts --check

cli_tarball_name="$(packaged_cli_tarball)"
cli_tarball_path="$TMP_ROOT/$cli_tarball_name"
smoke_install_cli "$cli_tarball_path"

run_in_dir "$ROOT_DIR/integrations/elizaos" npm install --no-package-lock
run_in_dir "$ROOT_DIR/integrations/elizaos" npm pack --dry-run

run_in_dir "$ROOT_DIR/integrations/mcp" npm install --no-package-lock
run_in_dir "$ROOT_DIR/integrations/mcp" npm pack --dry-run

run_in_dir "$ROOT_DIR/integrations/openclaw" npm install --no-package-lock
run_in_dir "$ROOT_DIR/integrations/openclaw" npm run typecheck
run_in_dir "$ROOT_DIR/integrations/openclaw" npm test
run_in_dir "$ROOT_DIR/integrations/openclaw" npm pack --dry-run

build_python_package "$ROOT_DIR/integrations/hermes" "hermes"
build_python_package "$ROOT_DIR/integrations/langchain" "langchain"

run_in_dir "$ROOT_DIR/backend" bun run typecheck
run_in_dir "$ROOT_DIR/frontend" npm run build

log "ok"
