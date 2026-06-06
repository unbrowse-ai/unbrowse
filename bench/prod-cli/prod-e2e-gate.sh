#!/usr/bin/env bash
# prod-e2e-gate.sh — the "rebench on prod" witness. Drives the PUBLISHED prod CLI off the
# registry (npx unbrowse@<ref>, sandboxed — no host install) and proves it actually works
# end to end, not just that the tarball carries the head:
#   1. VERSION — npx unbrowse@<ref> --version resolves + runs.
#   2. FETCH   — npx unbrowse@<ref> fetch <url> retrieves real content (HTTP 200 + body token).
#   3. HEAD    — the published artifact carries the embedded energy head (delegates to
#                registry-live-gate.sh).
# Exits 0 only when all three hold. This is the honest counter to the captured nebius-qa
# clean-VM failure: it records whether THIS published build works on the real prod CLI.
set -uo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
REF="${1:-preview}"
fail=0

echo "=== 1. VERSION — npx unbrowse@$REF runs off the registry ==="
V="$(cd /tmp && timeout 240 npx --yes "unbrowse@$REF" --version 2>/dev/null | grep -oE '[0-9]+\.[0-9]+\.[0-9]+(-[a-z.0-9]+)?' | tail -1)"
if [ -n "$V" ]; then echo "[e2e] prod CLI version: $V ✅"; else echo "[e2e] prod CLI --version FAILED ❌"; fail=1; fi

echo "=== 2. FETCH — prod CLI retrieves real content E2E ==="
OUT="$(cd /tmp && timeout 180 npx --yes "unbrowse@$REF" fetch "https://example.com" 2>/dev/null)"
if printf '%s' "$OUT" | grep -qiE 'Example Domain'; then
  echo "[e2e] prod CLI fetch retrieved real content (Example Domain) ✅"
  printf '%s' "$OUT" | grep -oE '\[fetch\] [0-9]+ [0-9]+ms [^·]*' | head -1 | sed 's/^/    /'
else
  echo "[e2e] prod CLI fetch did NOT retrieve content ❌"; fail=1
fi

echo "=== 3. HEAD — published artifact carries the embedded energy head ==="
if bash "$ROOT/bench/prod-cli/registry-live-gate.sh" "$REF" >/tmp/rl.$$.log 2>&1; then
  grep -oE 'carries head sha [a-f0-9]+' /tmp/rl.$$.log | head -1 | sed 's/^/[e2e] /'; echo "[e2e] head live on registry ✅"
else
  echo "[e2e] registry-live-gate RED:"; tail -3 /tmp/rl.$$.log | sed 's/^/    /'; fail=1
fi
rm -f /tmp/rl.$$.log

echo "================================================"
[ "$fail" -eq 0 ] && { echo "[prod-e2e] PASS — published prod CLI ($V) runs + fetches + carries the head, ON PROD"; exit 0; } \
                  || { echo "[prod-e2e] FAIL"; exit 1; }
