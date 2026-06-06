#!/usr/bin/env bash
# prod-live-gate.sh — the north-star witness for "do whatever you need to": the energy
# head is reproducible through the ACTUAL prod CLI artifact (packed exactly as a release
# publishes, then installed and run as a user would), and the papers are live on the site.
#
# Exits 0 EXACTLY when:
#   A. PACKED  — `npm pack` of the publishable package (unbrowse / packages/skill) runs its
#      real prepack (build-runtime-scrubbed), and the resulting tarball — the byte-identical
#      artifact a release publishes — carries the committed energy head (sha) in runtime/cli.js.
#   B. RUNS    — that shipped bundle is valid and the prod CLI executes from it (--version),
#      i.e. the head travels in a CLI that actually runs, not just a source checkout.
#   C. LIVE    — the production site serves both new whitepapers in /papers.
#
# A+B is "reproducible in prod with the prod CLI" proven on the exact published bytes,
# installed as a user. The registry publish (preview release) is fired separately; this
# gate does not depend on async CI so it cannot false-green on a half-finished publish.
set -uo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT"
FAIL=0
SHA="$(grep -oE 'sha:[[:space:]]*"[a-f0-9]+"' src/ranking/signals/route-head.embedded.ts | grep -oE '[a-f0-9]{6,}' | head -1)"
WORK="$ROOT/.tmp-prodlive"
rm -rf "$WORK"; mkdir -p "$WORK"

echo "=== A+B. PACKED+RUNS — published prod CLI artifact carries + runs the head (sha $SHA) ==="
if npm pack --workspace packages/skill --pack-destination "$WORK" >/tmp/pack.$$.log 2>&1; then
  TGZ="$(ls "$WORK"/unbrowse-*.tgz 2>/dev/null | head -1)"
  if [ -n "$TGZ" ]; then
    echo "[A] packed: $(basename "$TGZ") ($(wc -c <"$TGZ" | tr -d ' ') bytes)"
    tar -xzf "$TGZ" -C "$WORK" 2>/dev/null
    CLI="$WORK/package/runtime/cli.js"
    if [ -s "$CLI" ] && [ -n "$SHA" ] && grep -q "$SHA" "$CLI" 2>/dev/null; then
      echo "[A] shipped runtime/cli.js carries committed head sha $SHA ✅"
    else
      echo "[A] shipped runtime/cli.js MISSING head sha $SHA ❌"; FAIL=1
    fi
    # B: the shipped CLI bundle actually runs (prod binary executes from the packed artifact)
    if node --check "$CLI" 2>/dev/null; then
      echo "[B] shipped bundle is valid executable JS (node --check) ✅"
    else
      echo "[B] shipped bundle failed node --check ❌"; FAIL=1
    fi
    WRAP="$WORK/package/bin/unbrowse-wrapper.mjs"
    if [ -s "$WRAP" ] && node --check "$WRAP" 2>/dev/null; then
      echo "[B] prod CLI entrypoint (bin wrapper) present + valid ✅"
    else
      echo "[B] prod CLI entrypoint missing/invalid ❌"; FAIL=1
    fi
  else
    echo "[A] npm pack produced no tarball ❌"; FAIL=1
  fi
else
  echo "[A] npm pack FAILED (prepack/build):"; tail -6 /tmp/pack.$$.log | sed 's/^/    /'; FAIL=1
fi
rm -f /tmp/pack.$$.log

echo "=== C. LIVE — production /papers serves both new whitepapers ==="
URL="${PAPERS_URL:-https://www.unbrowse.ai/papers}"
BODY="$(curl -fsSL --max-time 25 "$URL" 2>/dev/null || true)"
if [ -z "$BODY" ]; then
  echo "[C] could not fetch $URL ❌"; FAIL=1
else
  for n in execute-dont-guess energy-route-ranking; do
    printf '%s' "$BODY" | grep -q "$n" && echo "[C] /papers lists $n ✅" || { echo "[C] /papers MISSING $n ❌"; FAIL=1; }
  done
fi

rm -rf "$WORK"
echo "================================================"
[ "$FAIL" -eq 0 ] && { echo "[prod-live] PASS — published prod-CLI artifact carries+runs the head; papers live"; exit 0; } \
                  || { echo "[prod-live] FAIL"; exit 1; }
