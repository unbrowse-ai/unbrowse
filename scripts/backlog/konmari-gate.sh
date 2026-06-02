#!/usr/bin/env bash
# konmari-gate.sh — witness for the konmari clean of the network-descent stack
# code (the layer solved this session: IProyal egress + curl-impersonate packet
# fetch). Keep only what is load-bearing. Verifies:
#   1. the dead orphans removed stay gone (no zombie re-introduction),
#   2. the network-descent modules still build,
#   3. the wiring test is green.
# Scope: the stack code we built/touched — not a whole-repo dead-code sweep.
set -uo pipefail
cd "$(dirname "$0")/../.."

# 1. Dead orphans pruned this pass must not reappear (buildIproyalCredsUrl was a
#    thin no-caller wrapper + a stale "legacy alias" comment; clearProxyAuthCache
#    reset a cache nothing cleared).
for s in buildIproyalCredsUrl clearProxyAuthCache; do
  n=$(grep -rE "\b$s\b" src/ packages/ tests/ 2>/dev/null | grep -v node_modules | wc -l | tr -d ' ')
  if [ "$n" != "0" ]; then echo "konmari-gate: FAIL — dead orphan '$s' reappeared ($n refs)"; exit 1; fi
done

# 2. The network-descent modules still build.
tmp=$(mktemp -d); trap 'rm -rf "$tmp"' EXIT
if ! bun build src/execution/proxy-fetch.ts src/cdp/proxy/iproyal.ts src/capture/curl-impersonate-fallback.ts \
     --target=node --outdir="$tmp" >/dev/null 2>&1; then
  echo "konmari-gate: FAIL — network-descent modules do not build"; exit 1
fi

# 3. The wiring stays green.
if ! bun test tests/iproyal-proxy-wiring.test.ts >/dev/null 2>&1; then
  echo "konmari-gate: FAIL — iproyal wiring test red"; exit 1
fi

echo "konmari-gate: ok — network-descent stack code is load-bearing (dead orphans gone, builds, tests green)"
exit 0
