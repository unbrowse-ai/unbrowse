#!/usr/bin/env bash
# descent-cache-gate.sh — witness for descent-cache-pipe.
#
# The node (Paper 2 §2+§5, the user's "everything is a fallback to another that
# is kv cached to a pipe… can't be beat for speed"): the self-similar descent as
# ONE reusable primitive — try the highest layer that can answer, fall back down
# the ladder, cache the win by content-address so the next call short-circuits.
# Verifies:
#   1. the module builds (Web Crypto content-address + cache + descent),
#   2. cache hit short-circuits the ladder (speed), miss tries layers top-down
#      and the first win stops the descent, the win is cached, a miss is not,
#      content-addressing is host-independent — via the test.
set -uo pipefail
cd "$(dirname "$0")/../.."

tmp=$(mktemp -d); trap 'rm -rf "$tmp"' EXIT
if ! bun build src/trust/descent-cache.ts --target=node --outdir="$tmp" >/dev/null 2>&1; then
  echo "descent-cache-gate: FAIL — descent-cache module does not build"; exit 1
fi

if ! bun test tests/descent-cache.test.ts >/dev/null 2>&1; then
  echo "descent-cache-gate: FAIL — descent-cache test red"; exit 1
fi

echo "descent-cache-gate: ok — cache-first fallback pipe (hit short-circuits the ladder, first layer that answers wins, win cached by content-address, miss not cached)"
exit 0
