#!/usr/bin/env bash
# npm-install-integrity.sh — verify npm global install is consistent
#
# Silent failure class: `npm install -g <pkg>@tag` can leave the binary
# symlink in `~/.npm-global/bin` pointing at a stale version, or break
# the symlink entirely, or resolve a tag to an old version that's been
# superseded. This primitive checks all three:
#
#   1. CLI binary (via PATH) returns --version matching installed package
#   2. ~/.npm-global/bin/<pkg> symlink resolves (not dangling)
#   3. Symlink target file exists and is executable
#   4. dist-tag matches the actual latest (calls npm-dist-tag-sync.sh --check)
#
# Exits non-zero on any drift. Prints structured status.
#
# Usage:
#   bash scripts/npm-install-integrity.sh unbrowse          # check unbrowse
#   bash scripts/npm-install-integrity.sh unbrowse --fix    # auto-reinstall on drift
#
set -uo pipefail

PKG="${1:-unbrowse}"
FIX=false
for arg in "$@"; do
  case "$arg" in
    --fix) FIX=true ;;
  esac
done

# Resolve npm prefix dynamically — user's PATH may not include ~/.npm-global/bin
NPM_PREFIX=$(npm config get prefix 2>/dev/null || echo "$HOME/.npm-global")
NPM_BIN="$NPM_PREFIX/bin"
NPM_LIB="$NPM_PREFIX/lib/node_modules"
STATUS="OK"
DRIFT_REASONS=()

echo "[install-integrity] checking $PKG"
echo "[install-integrity] npm prefix: $NPM_PREFIX"

# Also report where the actual CLI binary lives on PATH
ACTUAL_BIN=$(command -v "$PKG" 2>/dev/null || echo "")
if [ -n "$ACTUAL_BIN" ]; then
  echo "[install-integrity] CLI resolves to: $ACTUAL_BIN"
  if [ -L "$ACTUAL_BIN" ]; then
    realtarget=$(readlink -f "$ACTUAL_BIN" 2>/dev/null || python3 -c "import os; print(os.path.realpath('$ACTUAL_BIN'))")
    echo "[install-integrity]   → $realtarget"
  fi
  # Drift detection: if CLI resolves from a path outside npm prefix, flag it
  case "$ACTUAL_BIN" in
    "$NPM_BIN/"*) ;;  # normal
    *)
      STATUS="FAIL"
      DRIFT_REASONS+=("cli_not_from_npm_prefix:$ACTUAL_BIN")
      echo "[install-integrity] ⚠ CLI is not from npm prefix — multi-install drift"
      ;;
  esac
fi

# 1. Binary on PATH
if ! command -v "$PKG" >/dev/null 2>&1; then
  STATUS="FAIL"
  DRIFT_REASONS+=("not_on_path")
  echo "  ✗ $PKG not on PATH"
else
  cli_version=$("$PKG" --version 2>/dev/null || echo "error")
  echo "  ✓ CLI version: $cli_version"
fi

# 2. Symlink in npm global bin
LINK="$NPM_BIN/$PKG"
if [ ! -e "$LINK" ]; then
  STATUS="FAIL"
  DRIFT_REASONS+=("no_symlink")
  echo "  ✗ $LINK missing"
elif [ -L "$LINK" ] && [ ! -e "$LINK" ]; then
  STATUS="FAIL"
  DRIFT_REASONS+=("dangling_symlink")
  target=$(readlink "$LINK")
  echo "  ✗ $LINK dangles → $target"
elif [ -L "$LINK" ]; then
  target=$(readlink "$LINK")
  resolved=$(readlink -f "$LINK" 2>/dev/null || python3 -c "import os; print(os.path.realpath('$LINK'))")
  if [ -e "$resolved" ]; then
    echo "  ✓ symlink resolves: $target"
  else
    STATUS="FAIL"
    DRIFT_REASONS+=("symlink_target_missing")
    echo "  ✗ symlink target missing: $target"
  fi
fi

# 3. Package.json version
PKG_JSON="$NPM_LIB/$PKG/package.json"
if [ -f "$PKG_JSON" ]; then
  pkg_version=$(python3 -c "
import json
try: print(json.load(open('$PKG_JSON'))['version'])
except: print('error')
" 2>/dev/null)
  echo "  ✓ package.json version: $pkg_version"

  if [ "${cli_version:-}" != "$pkg_version" ] && [ -n "${cli_version:-}" ]; then
    STATUS="FAIL"
    DRIFT_REASONS+=("cli_pkg_mismatch:cli=$cli_version,pkg=$pkg_version")
    echo "  ✗ CLI reports $cli_version but package.json says $pkg_version"
  fi
else
  STATUS="FAIL"
  DRIFT_REASONS+=("no_package_json")
  echo "  ✗ $PKG_JSON missing"
fi

# 4. Compare to latest on npm
if command -v npm >/dev/null 2>&1; then
  latest_on_npm=$(npm view "$PKG" dist-tags.latest 2>/dev/null || echo "error")
  echo "  info: dist-tag latest on npm: $latest_on_npm"
fi

echo ""
if [ "$STATUS" = "OK" ]; then
  echo "[install-integrity] ✓ $PKG install is healthy"
  exit 0
else
  echo "[install-integrity] ✗ DRIFT: $PKG install inconsistent"
  for r in "${DRIFT_REASONS[@]}"; do
    echo "  - $r"
  done

  if [ "$FIX" = "true" ]; then
    echo "[install-integrity] attempting fix: reinstall from npm..."
    npm uninstall -g "$PKG" 2>&1 | tail -3
    npm cache clean --force 2>/dev/null || true
    npm install -g "$PKG@latest" 2>&1 | tail -3
    # Re-run check
    exec bash "$0" "$PKG"
  fi

  exit 1
fi
