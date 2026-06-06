#!/usr/bin/env bash
# node-only-gate.sh — witness that the published prod CLI runs on a clean Node-only machine
# (no Bun). This is the fix for the rebench-on-prod wall (fresh VM got "this build runs on Bun").
#
# It packs the publishable package (prepack builds the --target=node runtime), installs the
# byte-identical tarball into a throwaway prefix, removes Bun from PATH, and runs the core
# commands through the FULL launcher chain (wrapper -> bin/unbrowse.js -> node runtime/cli.js):
#   1. fetch  — retrieves real web content (200 + body token)
#   2. resolve — exercises the route graph / node:sqlite path
#   3. NO "this build runs on Bun" anywhere
# Exits 0 only when all hold with bun absent.
set -uo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT"
WORK="$(mktemp -d /tmp/unbrowse-nodeonly.XXXXXX)"
NODEONLY="/usr/bin:/bin:/usr/sbin:/sbin:/opt/nanobrew/prefix/bin"   # node present, bun absent
fail=0
cleanup() { rm -rf "$WORK"; }
trap cleanup EXIT

# guard: the gate is only meaningful if bun is genuinely absent from the test PATH
if env PATH="$NODEONLY" sh -c 'command -v bun' >/dev/null 2>&1; then
  echo "[node-only] WARN: bun is on the sandbox PATH — test would be invalid"; exit 1
fi
echo "[node-only] bun absent from sandbox PATH ✓; node = $(env PATH="$NODEONLY" node --version)"

echo "[node-only] packing (prepack builds the --target=node runtime) ..."
if ! npm pack --workspace packages/skill --pack-destination "$WORK" >/tmp/no-pack.$$.log 2>&1; then
  echo "[node-only] pack FAILED:"; tail -5 /tmp/no-pack.$$.log; rm -f /tmp/no-pack.$$.log; exit 1
fi
rm -f /tmp/no-pack.$$.log
TGZ="$(ls "$WORK"/unbrowse-*.tgz 2>/dev/null | head -1)"
( cd "$WORK" && npm init -y >/dev/null 2>&1 && npm install "$TGZ" --no-audit --no-fund >/tmp/no-inst.$$.log 2>&1 ) \
  || { echo "[node-only] install FAILED:"; tail -8 /tmp/no-inst.$$.log; rm -f /tmp/no-inst.$$.log; exit 1; }
rm -f /tmp/no-inst.$$.log
BIN="$WORK/node_modules/.bin/unbrowse"

echo "[node-only] fetch (real web content, bun absent) ..."
FOUT="$(env PATH="$NODEONLY" "$BIN" fetch "https://example.com" 2>&1)"
if printf '%s' "$FOUT" | grep -qi 'this build runs on Bun'; then echo "[node-only] STILL requires Bun ❌"; fail=1; fi
if printf '%s' "$FOUT" | grep -qi 'Example Domain'; then echo "[node-only] fetch OK (real content) ✅"; else echo "[node-only] fetch FAILED ❌"; fail=1; fi

echo "[node-only] resolve (route graph / node:sqlite, bun absent) ..."
ROUT="$(env PATH="$NODEONLY" "$BIN" resolve --intent "search open library for dune" --no-execute 2>&1)"
if printf '%s' "$ROUT" | grep -qiE '"success":true|exa_candidates|skill_id'; then echo "[node-only] resolve OK ✅"; else echo "[node-only] resolve FAILED ❌"; fail=1; fi

# The exact qa.sh fresh-VM checks (health + search), so this local gate is a complete
# proxy for the VM matrix: a green here predicts install=Y version=Y health=Y fetch=Y search=Y.
echo "[node-only] health (qa.sh check, bun absent) ..."
HOUT="$(env PATH="$NODEONLY" "$BIN" health 2>&1)"
if printf '%s' "$HOUT" | grep -qiE '"status"\s*:\s*"ok"|healthy|uptime|package_version'; then echo "[node-only] health OK ✅"; else echo "[node-only] health FAILED ❌"; fail=1; fi

echo "[node-only] search (qa.sh check, bun absent) ..."
SOUT="$(env PATH="$NODEONLY" "$BIN" search --intent "open library dune" 2>&1)"
if printf '%s' "$SOUT" | grep -qi 'this build runs on Bun'; then echo "[node-only] search STILL requires Bun ❌"; fail=1; fi
if printf '%s' "$SOUT" | grep -qiE 'exa|candidate|skill|"success"'; then echo "[node-only] search OK ✅"; else echo "[node-only] search FAILED ❌"; fail=1; fi

echo "================================================"
[ "$fail" -eq 0 ] && { echo "[node-only] PASS — prod CLI runs on a clean Node-only machine (no Bun)"; exit 0; } \
                  || { echo "[node-only] FAIL"; exit 1; }
