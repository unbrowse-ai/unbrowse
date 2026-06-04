#!/usr/bin/env bash
# build-runtime-scrubbed.sh — build the readable npm runtime bundle from a SCRUBBED
# copy of src/, so the published `unbrowse` runtime carries no internal vocabulary
# and matches the public audit repo. The client is readable+unsigned by design;
# "readable" must therefore also mean "clean".
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"
OUTDIR="${1:-packages/skill/runtime}"

TMP="$ROOT/.tmp-runtime-src"   # inside the repo so node_modules resolves on build
rm -rf "$TMP"; mkdir -p "$TMP"
cp -R "$ROOT/src/." "$TMP/"
cleanup() { rm -rf "$TMP"; }
trap cleanup EXIT

echo "[runtime] scrubbing the runtime source copy..."
bash "$ROOT/scripts/scrub-vocab.sh" "$TMP"

echo "[runtime] bundling scrubbed cli.ts -> $OUTDIR ..."
rm -rf "$ROOT/$OUTDIR"; mkdir -p "$ROOT/$OUTDIR"
bun build "$TMP/cli.ts" --target=bun --outdir "$ROOT/$OUTDIR" >/dev/null

# Verify the produced bundle carries no internal vocabulary (fail closed). EBM/energy
# identifiers are matched CASE-SENSITIVELY (the tell is uppercase EBM / camelCase energyHead);
# lowercase "ebm" inside embedded base64 binary assets is noise, not a leak.
# `|| true` so a CLEAN bundle (grep no-match → exit 1) does not trip set -e/pipefail.
# (bare 'EBM' is 3 chars and appears in embedded base64 binary — only specific
#  identifiers are scanned in the bundle; the text mirror gate catches bare EBM.)
hits="$( { grep -aoE 'energy-based|energyHead|ledgerEnergy|routeEnergy|learnedEnergy' "$ROOT/$OUTDIR"/*.js 2>/dev/null || true; \
           grep -aoiE 'covenant|superpattern|\bjesus\b|firmament|grain-of-wheat|\bsabbath\b|zero.?knowledge|nullifier|\bsubstrate\b' "$ROOT/$OUTDIR"/*.js 2>/dev/null || true; } | wc -l | tr -d ' ' || true)"
if [ "${hits:-0}" -ne 0 ]; then
  echo "[runtime] FAIL: scrubbed bundle still carries $hits vocab hit(s)" >&2
  grep -aoE 'covenant|superpattern|\bjesus\b|firmament|nullifier|\bsubstrate\b' "$ROOT/$OUTDIR"/*.js 2>/dev/null | sort | uniq -c >&2
  exit 1
fi
echo "[runtime] clean: readable runtime bundle built from scrubbed src ($OUTDIR), 0 vocab hits"
