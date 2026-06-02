#!/usr/bin/env bash
# kuri-pr-gate.sh — witness for kuri-upstream-pr: a live PR exists on the
# upstream justrach/kuri from our fork branch carrying the stateless/winsock
# Windows-port work. Verified existing: PR #163, open since 2026-05-23.
# Network/gh-dependent: if gh can't reach GitHub it SKIPS (prints so) rather
# than failing the whole backlog gate.
set -uo pipefail

if ! command -v gh >/dev/null 2>&1; then
  echo "kuri-pr-gate: SKIP (gh not installed)"; exit 0
fi

out=$(timeout 30 gh pr list --repo justrach/kuri --head feat/windows-port-wave-1 \
  --state open --json number,title -q '.[0].number' 2>/dev/null || true)

if [ -z "$out" ]; then
  # Could be no-PR OR gh/network/auth failure — distinguish by a cheap reachability probe.
  if ! timeout 20 gh repo view justrach/kuri --json name >/dev/null 2>&1; then
    echo "kuri-pr-gate: SKIP (gh/GitHub unreachable)"; exit 0
  fi
  echo "kuri-pr-gate: FAIL — no open PR from feat/windows-port-wave-1 on justrach/kuri"
  exit 1
fi

echo "kuri-pr-gate: ok — open PR #$out on justrach/kuri (fork branch feat/windows-port-wave-1)"
exit 0
