#!/usr/bin/env bash
# windows-runtime-gate.sh — witness: a real end-to-end Windows run (resolve +
# browse, not just a build) has passed in CI. test-windows.yml runs on
# windows-latest and, as REQUIRED steps (no continue-on-error), does
# `unbrowse.exe go example.com -> snap -> close` asserting "ok":true, plus a
# real `unbrowse.exe resolve`. A green run = a real Windows e2e. Network/gh
# dependent: SKIP (exit 0) if gh/GitHub is unreachable.
set -uo pipefail
command -v gh >/dev/null 2>&1 || { echo "windows-runtime-gate: SKIP (gh not installed)"; exit 0; }
ok=$(timeout 30 gh run list --workflow=test-windows.yml --limit 15 \
  --json conclusion -q '[.[]|select(.conclusion=="success")]|length' 2>/dev/null || echo "")
if [ -z "$ok" ]; then
  timeout 20 gh repo view --json name >/dev/null 2>&1 || { echo "windows-runtime-gate: SKIP (gh/GitHub unreachable)"; exit 0; }
  echo "windows-runtime-gate: FAIL — could not read test-windows.yml runs"; exit 1
fi
if [ "$ok" -gt 0 ]; then
  echo "windows-runtime-gate: ok — $ok successful Windows E2E run(s) (go+snap+close + resolve on windows-latest)"; exit 0
fi
echo "windows-runtime-gate: FAIL — no successful Windows E2E run found"; exit 1
