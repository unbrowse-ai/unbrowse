#!/usr/bin/env bash
# precommit.sh — fast, dependency-free pre-commit checks for contributors.
#
# 1. Version consistency: package.json version must match version.json.
# 2. Secret hygiene: refuse to stage obvious credentials.
set -uo pipefail
ROOT="$(git rev-parse --show-toplevel)"
cd "$ROOT"

fail=0

echo "[precommit] version consistency"
if [ -f scripts/check-version-consistency.ts ] && command -v bun >/dev/null 2>&1; then
  bun scripts/check-version-consistency.ts || fail=1
fi

echo "[precommit] secret scan on staged files"
leaks=$(git diff --cached --name-only --diff-filter=ACMR -z |
  xargs -0 -r grep -lIiE \
    '-----BEGIN (RSA|EC|OPENSSH|PGP) PRIVATE KEY|ghp_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{20,}|AKIA[0-9A-Z]{16}|AIza[0-9A-Za-z_-]{35}|sk-[a-zA-Z0-9]{40,}' \
  2>/dev/null || true)
if [ -n "${leaks:-}" ]; then
  echo "[precommit] ✗ possible credentials staged:" >&2
  echo "$leaks" >&2
  fail=1
fi

if [ "$fail" -ne 0 ]; then
  echo "[precommit] FAILED" >&2
  exit 1
fi
echo "[precommit] ok"
