#!/usr/bin/env bash
# konmari-live-gate.sh — the witness that the KONMARI is LIVE on the registry: the published
# package, pulled fresh off npm, carries the lightening (deps cut + host-only prune with the
# win32 fix). Exits 0 only when the published artifact a real `npm i` gets is the lightened one.
#   bash konmari-live-gate.sh [version-or-dist-tag]   # default: preview
set -uo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT"
REF="${1:-preview}"
WORK="$(mktemp -d /tmp/konmari-live.XXXXXX)"; trap 'rm -rf "$WORK"' EXIT
fail=0

PUB="$(npm view "unbrowse@$REF" version 2>/dev/null | tail -1)"
[ -z "$PUB" ] && { echo "[konmari-live] unbrowse@$REF not published yet"; exit 1; }
echo "[konmari-live] registry unbrowse@$REF -> $PUB"

npm pack "unbrowse@$REF" --pack-destination "$WORK" >/dev/null 2>&1 || { echo "[konmari-live] npm pack from registry failed"; exit 1; }
TGZ="$(ls "$WORK"/unbrowse-*.tgz | head -1)"
tar -xzf "$TGZ" -C "$WORK" 2>/dev/null
P="$WORK/package"

# 1. the prune script ships
if [ -s "$P/scripts/prune-foreign-binaries.mjs" ]; then echo "[konmari-live] prune script ships ✅"; else echo "[konmari-live] FAIL: prune script missing from published tarball"; fail=1; fi
# 2. the win32 fix is in the published prune
if grep -q 'win-x64' "$P/scripts/prune-foreign-binaries.mjs" 2>/dev/null; then echo "[konmari-live] published prune has the win32→win-x64 fix ✅"; else echo "[konmari-live] FAIL: published prune lacks the win32 fix"; fail=1; fi
# 3. postinstall wires the prune
if grep -q 'prune-foreign-binaries' "$P/scripts/postinstall.mjs" 2>/dev/null; then echo "[konmari-live] postinstall runs the prune ✅"; else echo "[konmari-live] FAIL: postinstall does not run the prune"; fail=1; fi
# 4. the 4 removed deps are gone from the published package.json
for d in '@x402/fetch' '@solana/kit' '@fastify/rate-limit' '@faremeter/flex-solana'; do
  if node -e "const p=require('$P/package.json');process.exit(((p.dependencies&&p.dependencies['$d'])||(p.optionalDependencies&&p.optionalDependencies['$d']))?0:1)"; then
    echo "[konmari-live] FAIL: removed dep present in published package: $d"; fail=1
  fi
done
NDEPS="$(node -p "Object.keys(require('$P/package.json').dependencies||{}).length")"
[ "$NDEPS" -le 7 ] && echo "[konmari-live] published runtime deps $NDEPS <= 7 ✅" || { echo "[konmari-live] FAIL: published deps $NDEPS > 7"; fail=1; }

echo "================================================"
[ "$fail" -eq 0 ] && { echo "[konmari-live] PASS — the konmari is LIVE on the registry ($PUB)"; exit 0; } \
                  || { echo "[konmari-live] FAIL — published package not yet lightened"; exit 1; }
