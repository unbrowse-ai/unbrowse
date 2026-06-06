#!/usr/bin/env bash
# registry-live-gate.sh — the witness that the energy head is LIVE on the npm registry
# in the prod CLI, via the preview dist-tag (latest untouched). Exits 0 exactly when the
# published artifact, pulled fresh from the registry, carries the committed head sha.
#
#   bash registry-live-gate.sh [version-or-dist-tag]   # default: preview
#
# It does NOT build anything: it `npm pack`s the PUBLISHED package straight off the
# registry, unpacks it, and greps the shipped runtime/cli.js for the head sha. So a green
# here means a real user running `npx unbrowse@<tag>` gets the head — not a local build.
set -uo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT"
REF="${1:-preview}"
SHA="$(grep -oE 'sha:[[:space:]]*"[a-f0-9]+"' src/ranking/signals/route-head.embedded.ts | grep -oE '[a-f0-9]{6,}' | head -1)"
WORK="$ROOT/.tmp-registry-live"; rm -rf "$WORK"; mkdir -p "$WORK"

echo "=== registry-live: unbrowse@$REF must carry head sha $SHA ==="
PUB="$(npm view "unbrowse@$REF" version 2>/dev/null | tail -1)"
if [ -z "$PUB" ]; then
  echo "[reg] unbrowse@$REF not published yet (CI still building, or tag not cut)"; rm -rf "$WORK"; exit 1
fi
echo "[reg] registry resolves unbrowse@$REF -> $PUB"
if npm pack "unbrowse@$REF" --pack-destination "$WORK" >/tmp/regpack.$$.log 2>&1; then
  TGZ="$(ls "$WORK"/unbrowse-*.tgz 2>/dev/null | head -1)"
  tar -xzf "$TGZ" -C "$WORK" 2>/dev/null
  CLI="$WORK/package/runtime/cli.js"
  if [ -s "$CLI" ] && [ -n "$SHA" ] && grep -q "$SHA" "$CLI" 2>/dev/null; then
    echo "[reg] PUBLISHED unbrowse@$PUB runtime/cli.js carries head sha $SHA ✅"
    rm -rf "$WORK"; echo "[registry-live] PASS — head live on registry ($PUB)"; exit 0
  else
    echo "[reg] published unbrowse@$PUB MISSING head sha $SHA ❌"; rm -rf "$WORK"; exit 1
  fi
else
  echo "[reg] npm pack from registry failed:"; tail -4 /tmp/regpack.$$.log | sed 's/^/    /'; rm -rf "$WORK"; exit 1
fi
