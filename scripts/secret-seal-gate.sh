#!/usr/bin/env bash
# secret-seal-gate.sh — three-plane witness that secrets never leave the client.
#
# Planes (fail any one → exit 1):
#   1. REPO   — moat/vocab leak-guard (public paths, npm tarball simulation)
#   2. INDEX  — publish credential boundary (sanitize allowlist + wire seal)
#   3. HEADERS/WIRE — structural assert refuses cookie/authorization values on
#                    the marketplace POST body; outbound Unbrowse API auth is
#                    only the local agent Bearer (never site session headers)
#
# Usage:
#   bash scripts/secret-seal-gate.sh
#   bash scripts/secret-seal-gate.sh --skip-repo   # unit planes only
#
# Wired from pre-commit when publish/sanitize/marketplace/client change.
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

SKIP_REPO=0
for arg in "$@"; do
  case "$arg" in
    --skip-repo) SKIP_REPO=1 ;;
  esac
done

fail=0
section() { echo ""; echo "=== secret-seal: $1 ==="; }

section "1/3 REPO (leak-guard moat boundary)"
if [ "$SKIP_REPO" -eq 1 ]; then
  echo "skipped (--skip-repo)"
else
  if bash scripts/leak-guard.sh; then
    echo "REPO: PASS"
  else
    echo "REPO: FAIL"; fail=1
  fi
fi

section "2–3/3 INDEX + HEADERS/WIRE (credential boundary + wire seal)"
if bun test \
  tests/publish-credential-boundary.test.ts \
  tests/sanitize-for-publish.test.ts \
  tests/contribution-no-leak.test.ts \
  tests/secret-seal-planes.test.ts
then
  echo "INDEX+WIRE: PASS"
else
  echo "INDEX+WIRE: FAIL"; fail=1
fi

section "verdict"
if [ "$fail" -eq 0 ]; then
  echo "SECRET-SEAL PASS — repo + index + wire planes clean."
  exit 0
fi
echo "SECRET-SEAL FAIL — a secret-shaped value could leave the client or public surface."
exit 1
