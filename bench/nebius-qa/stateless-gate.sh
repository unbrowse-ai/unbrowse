#!/usr/bin/env bash
# WITNESS — unbrowse is a completely stateless, self-contained binary (no Bun,
# no long-lived kuri daemon) that performs the same. Failing-first by design:
# it stays RED until the kuri broker is replaced by ephemeral-per-call
# primitives (contract 8120be81). Each clause is a real, runnable check — no
# self-asserted green.
#
# Clauses:
#   A. NO-BUN     — the readable runtime builds for Node and runs core commands
#                   on plain `node` with Bun hidden (Bun dependency removed).
#   B. STATELESS-FETCH — `fetch` returns real content WITHOUT spawning a kuri
#                   daemon (no :7800 listener appears) — the in-process path.
#   C. NO-BROKER-STATE — the shared `brokerClients` Map is gone from src/ (the
#                   8120be81 structural constraint: per-call-ephemeral, no shared
#                   broker handle map).
#   D. STATELESS-BROWSE — `go`+`snap`+`close` work on Node AND leave no lingering
#                   kuri daemon afterward (per-call-ephemeral browse).
set -uo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$HERE/../.." && pwd)"
cd "$ROOT"
RT="$ROOT/tmp/ub-stateless-runtime"
KURI="$ROOT/packages/skill/vendor/kuri/$( [ "$(uname)" = Darwin ] && echo darwin-arm64 || echo linux-x64 )/kuri"
fail=0
note() { echo "[stateless-gate] $*"; }
clause() { if [ "$2" -eq 0 ]; then echo "  ✓ $1"; else echo "  ✗ $1"; fail=1; fi; }

# ---- build the Node runtime (no Bun in the bundle) -------------------------
note "building Node-target runtime..."
if ! bash scripts/build-runtime-scrubbed.sh "tmp/ub-stateless-runtime" >/tmp/sg-build.log 2>&1; then
  note "BUILD FAILED"; tail -5 /tmp/sg-build.log; exit 1
fi
CLI="$RT/cli.js"
[ -f "$CLI" ] || { note "no cli.js emitted"; exit 1; }
bun_in_bundle="$(grep -aoE 'bun:(ffi|sqlite|test)' "$CLI" 2>/dev/null | sort -u | tr '\n' ' ')"

# A. NO-BUN: run core commands on plain node, Bun hidden -----------------------
ver="$(node "$CLI" --version 2>/dev/null | head -1)"
hrc=1; node "$CLI" health >/dev/null 2>&1 && hrc=0
frc=1; fbytes=0
fout="$(timeout 90 node "$CLI" fetch https://api.github.com/repos/nodejs/node 2>/dev/null)"; frc=$?
fbytes=$(printf '%s' "$fout" | wc -c | tr -d ' ')
a_ok=0
{ [ "$hrc" -eq 0 ] && [ "$frc" -eq 0 ] && [ "$fbytes" -gt 200 ] && [ -z "$bun_in_bundle" ]; } || a_ok=1
clause "A. NO-BUN (node health+fetch ok=$([ $hrc -eq 0 ] && [ $frc -eq 0 ] && echo y || echo n) bytes=$fbytes bundle-bun='${bun_in_bundle:-none}')" "$a_ok"

# B. STATELESS-FETCH: fetch spawns no kuri daemon -----------------------------
pkill -9 -f "vendor/kuri/.*/kuri" 2>/dev/null || true
sleep 1
timeout 90 node "$CLI" fetch https://example.com >/dev/null 2>&1
kuri_after_fetch="$(pgrep -f 'vendor/kuri/.*/kuri' | wc -l | tr -d ' ')"
b_ok=$([ "$kuri_after_fetch" -eq 0 ] && echo 0 || echo 1)
clause "B. STATELESS-FETCH (kuri procs after fetch=$kuri_after_fetch, want 0)" "$b_ok"

# C. NO-BROKER-STATE: shared brokerClients Map removed from src/ --------------
broker_hits="$(git grep -cE "brokerClients\b" -- 'src/*' 2>/dev/null | wc -l | tr -d ' ')"
c_ok=$([ "$broker_hits" -eq 0 ] && echo 0 || echo 1)
clause "C. NO-BROKER-STATE (src files with shared brokerClients Map=$broker_hits, want 0)" "$c_ok"

# D. STATELESS-BROWSE: go/snap/close work AND leave no daemon -----------------
d_ok=1
if [ -x "$KURI" ]; then
  export UNBROWSE_KURI_BIN="$KURI"
  pkill -9 -f "vendor/kuri/.*/kuri" 2>/dev/null || true; sleep 1
  sid="sg-$$"
  go_out="$(timeout 90 node "$CLI" go https://example.com --session "$sid" 2>&1)"
  snap_out="$(timeout 60 node "$CLI" snap --session "$sid" 2>&1)"
  timeout 40 node "$CLI" close --session "$sid" >/dev/null 2>&1
  sleep 3
  kuri_after_browse="$(pgrep -f 'vendor/kuri/.*/kuri' | wc -l | tr -d ' ')"
  browse_worked=$(printf '%s' "$snap_out" | grep -qiE '@e[0-9]|example|domain|heading|link' && echo 1 || echo 0)
  { [ "$browse_worked" -eq 1 ] && [ "$kuri_after_browse" -eq 0 ]; } && d_ok=0
  clause "D. STATELESS-BROWSE (snap-worked=$browse_worked, kuri-procs-after=$kuri_after_browse want 0)" "$d_ok"
else
  clause "D. STATELESS-BROWSE (kuri binary absent at $KURI — cannot witness browse)" 1
fi

echo
if [ "$fail" -eq 0 ]; then
  note "WITNESS GREEN ✓ — stateless, self-contained, no Bun, no kuri daemon"
  exit 0
fi
note "WITNESS RED ✗ — strip remaining shared-state primitives (see clauses above)"
exit 1
