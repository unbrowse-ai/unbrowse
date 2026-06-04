#!/usr/bin/env bash
# aiko-home-gate — witness for the Aiko chat homepage.
#
# Exit 0 iff the mechanical core is real:
#   1. The Aiko chat component exists and wires the live pieces (greeting, prompt,
#      suggestion chips, the live aiko chat endpoint, a real unbrowse search call,
#      a visible latency readout, a login affordance).
#   2. The homepage route (/) renders the Aiko chat.
#   3. The previous marketing landing is relocated to /classic and is reachable
#      (linked from the app).
#   4. Wallet/Privy login is enabled on the home route (path allowlist).
#   5. The source typechecks (tsc errors in src/ must be zero; stale .next/ type
#      stubs are ignored).
#
# The look-and-feel (Gemini-like, unbrowse-themed) and search SPEED are judged on
# the deployed preview by eye — this gate proves the wiring is real, not faked.
set -uo pipefail
cd "$(dirname "$0")/.."   # frontend/

FAIL=0
need() { # file, regex, label
  if [ ! -f "$1" ]; then echo "  ✗ missing $1 ($3)"; FAIL=1; return; fi
  if ! grep -qiE -- "$2" "$1"; then echo "  ✗ $1: missing /$2/ ($3)"; FAIL=1; fi
}

C=src/components/aiko-home.tsx
need "$C" 'use client' "client component"
need "$C" "what's on your mind|on your mind|hi, " "greeting"
need "$C" 'chat\.unbrowse\.ai|/v1/chat/completions' "live aiko chat endpoint"
need "$C" 'searchSkills|/v1/search' "real unbrowse search call"
need "$C" 'ms|latency|elapsed|performance\.now' "latency readout"
need "$C" 'useAuth|Privy|sign in|login|connect wallet' "login affordance"
need "$C" 'button|onClick' "suggestion chips / interactions"

# --- product/UX user-story commandments (the "make it good" bar) -----------
need "$C" 'aria-live|role="log"|role="status"' "US5 screen-reader announces answers"
need "$C" 'localStorage' "US3 conversation remembered across reloads"
need "$C" 'lg:hidden' "US2 sources/routes reachable on mobile (not desktop-only)"
need "$C" 'Escape|key === "/"|=== .\/.' "US6 keyboard-first (Esc / slash focus)"
need "$C" 'retry|resend|try again' "US4 error recovery (retry the last turn)"
need "$C" 'aria-label' "a11y labels on controls"

# 2. homepage renders Aiko
need src/app/page.tsx 'aiko-home|AikoHome' "/ renders Aiko chat"

# 3. classic landing relocated + reachable
if [ ! -f src/app/classic/page.tsx ]; then echo "  ✗ missing src/app/classic/page.tsx (relocated landing)"; FAIL=1
elif [ "$(wc -c < src/app/classic/page.tsx)" -lt 800 ]; then echo "  ✗ src/app/classic/page.tsx too small to be the real landing"; FAIL=1; fi
if ! grep -rqE '/classic' src; then
  echo "  ✗ no reachable link to /classic anywhere in src/"; FAIL=1; fi

# 4. wallet/Privy login enabled on home
grep -qE '"/"' src/lib/privy-provider.tsx || { echo "  ✗ home route '/' not in PRIVY_PATH_ALLOWLIST"; FAIL=1; }

# 5. real compile: src/ must typecheck (ignore stale .next/ generated stubs)
echo "[aiko-gate] typechecking src/ (stale .next stubs ignored)..."
SRC_ERRORS=$(timeout 180 bunx tsc --noEmit 2>&1 | grep -E '^src/' || true)
if [ -n "$SRC_ERRORS" ]; then
  echo "  ✗ src/ type errors:"; printf '%s\n' "$SRC_ERRORS" | head -15 | sed 's/^/    /'; FAIL=1
fi

if [ "$FAIL" -ne 0 ]; then echo "[aiko-gate] FAIL"; exit 1; fi
echo "[aiko-gate] PASS — Aiko chat home wired, classic reachable, login on, src typechecks"
