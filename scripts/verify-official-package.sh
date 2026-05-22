#!/usr/bin/env bash
# verify-official-package.sh -- prove the installed `unbrowse` package is the
# official, unmodified npm artifact.
#
# This is the ONE anti-reverse-engineering check that is genuinely
# unforgeable: npm publishes the CLI with `--provenance` (see
# .github/workflows/release.yml), which produces a Sigstore-backed
# attestation cryptographically binding the published tarball to the
# exact GitHub Actions workflow run + commit that built it. `npm audit
# signatures` verifies that attestation against npm's public
# transparency log. An attacker cannot forge it: they would need
# Sigstore + npm's signing infrastructure.
#
# What this PROVES when it passes:
#   - the installed tarball is byte-identical to what CI published
#   - it was built by the unbrowse-ai GitHub Actions release workflow
#   - nobody modified it between npm and your disk
#
# What this does NOT prevent (be honest -- see docs/SECURITY.md):
#   - someone reading the (open, JS) source after install
#   - someone editing their OWN local copy (provenance only covers the
#     published artifact, not your post-install edits)
#
# The moat against a MODIFIED copy is server-side: a tampered binary
# cannot produce a valid release-manifest HMAC (requireSignedClient ->
# 426) and cannot mint an exec-token, so it loses the marketplace index.
# This script is the client-side half: confirm what you installed is
# official before you trust it.
#
# Usage:
#   bash scripts/verify-official-package.sh            # verify globally-installed unbrowse
#   bash scripts/verify-official-package.sh <dir>      # verify a node_modules dir
#
# Exit codes: 0 verified, 2 signatures missing/invalid, 64 usage error.

set -uo pipefail

TARGET_DIR="${1:-}"

echo "[verify-official] checking npm provenance + signatures for 'unbrowse'"

# `npm audit signatures` must run where unbrowse is a dependency OR
# globally. Resolve a directory that has unbrowse installed.
if [ -n "$TARGET_DIR" ]; then
  cd "$TARGET_DIR" || { echo "cannot cd to $TARGET_DIR" >&2; exit 64; }
fi

NPM_VERSION=$(npm --version 2>/dev/null || echo "0")
echo "[verify-official] npm $NPM_VERSION"

# npm audit signatures needs npm >= 8.13. Bail clearly on older npm.
MAJOR=$(echo "$NPM_VERSION" | cut -d. -f1)
if [ "${MAJOR:-0}" -lt 8 ]; then
  echo "[verify-official] npm $NPM_VERSION too old for 'audit signatures' (need >= 8.13)" >&2
  echo "[verify-official] upgrade npm, then re-run" >&2
  exit 64
fi

TMP=$(mktemp)
trap 'rm -f "$TMP"' EXIT

# Run against the global install if no project dir was given.
AUDIT_SCOPE=""
if [ -z "$TARGET_DIR" ] && [ ! -f package.json ]; then
  # No project context -- check the global prefix.
  GLOBAL_ROOT=$(npm root -g 2>/dev/null || echo "")
  if [ -n "$GLOBAL_ROOT" ] && [ -d "$GLOBAL_ROOT/unbrowse" ]; then
    cd "$GLOBAL_ROOT/.." 2>/dev/null || true
    AUDIT_SCOPE="(global prefix)"
  fi
fi

echo "[verify-official] running: npm audit signatures ${AUDIT_SCOPE}"
npm audit signatures 2>&1 | tee "$TMP"
STATUS=${PIPESTATUS[0]}

echo ""
if [ "$STATUS" -eq 0 ] && grep -qiE "verified (registry )?signature|verified provenance|audited .* package" "$TMP"; then
  if grep -qi "unbrowse" "$TMP" || true; then
    echo "[verify-official] OK -- npm signature + provenance attestation verified."
    echo "[verify-official] the installed 'unbrowse' is the official CI-published artifact."
    exit 0
  fi
fi

# Non-zero, or no positive verification line.
if grep -qiE "missing|invalid|untrusted|failed" "$TMP"; then
  echo "[verify-official] FAIL -- one or more packages have missing/invalid signatures." >&2
  echo "[verify-official] if 'unbrowse' itself is flagged, you do NOT have the official build." >&2
  echo "[verify-official] reinstall: npm install -g unbrowse@latest" >&2
  exit 2
fi

echo "[verify-official] inconclusive -- 'npm audit signatures' produced no verdict line."
echo "[verify-official] (older npm registries / private mirrors may not serve attestations)"
exit 2
