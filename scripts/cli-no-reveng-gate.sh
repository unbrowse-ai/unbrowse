#!/usr/bin/env bash
# cli-no-reveng-gate — runnable witness for "the client CLI build carries no
# reverse-engineering engine." Exit 0 iff NO client-reachable source file under
# packages/skill/src imports the reverse-engineer engine module. The engine source
# stays in the repo (the backend imports it via ../../../src/reverse-engineer and
# runs it server-side at /v1/reveng); this gate only proves the CLIENT build is free
# of it, so the compiled binary cannot leak the moat. Sanitizers that MUST stay
# client-side (header/secret classification) are relocated to a client-safe module
# with no engine dependency, so a clean client imports nothing from reverse-engineer/.
set -uo pipefail
cd "$(dirname "$0")/.."
fail=0

echo "=== client build imports of the reverse-engineer engine (must be 0) ==="
# Use git grep on the TRUE path src/ — packages/skill/src is a symlink to ../../src,
# so non-symlink-following tools (BSD grep -r, find) silently miss the files; git grep
# scans tracked blobs by their real path. Match the import-path token "reverse-engineer/"
# (appears only in imports, never in prose which writes "reverse-engineering"), exclude
# the engine dir itself and tests, keep only real import lines.
leak=$(git grep -n "reverse-engineer/" -- 'src/**/*.ts' ':!src/reverse-engineer/**' ':!*.test.ts' \
        | grep -E 'import|from' || true)
if [ -z "$leak" ]; then
  echo "  ok — no client source imports the reverse-engineer engine"
else
  n=$(printf '%s\n' "$leak" | wc -l | tr -d ' ')
  echo "  FAIL — $n client import(s) of the engine remain:"
  printf '%s\n' "$leak" | sed 's/^/    /'
  fail=1
fi

echo
if [ "$fail" -ne 0 ]; then echo "[cli-no-reveng-gate] NOT YET — the client build still embeds the engine."; exit 1; fi
echo "[cli-no-reveng-gate] PASS — the client CLI build carries no reverse-engineering engine; the moat stays server-side."
