#!/usr/bin/env bash
# login-purge-repro.sh — reproduce or rule out the "constant logout" bug.
#
# Tests whether a cookie set in one browse session survives into the NEXT
# session (the vault save-on-close → load-on-go round-trip). Two modes:
#
#   1. PUBLIC (default, no credentials): httpbin cookie round-trip. Anyone /
#      CI can run it. If the cookie is LOST across sessions, the bug reproduces
#      for plain cookies (a vault/profile defect, not auth-specific).
#   2. AUTHED (pass a URL you're logged into): same round-trip against a real
#      site, checking your logged-in markers. Use when the public test passes
#      but you still get logged out — that points at httpOnly/auth-cookie or
#      concurrency specifics.
#
# It COLLECTS evidence (cookie names per session + the ~/.unbrowse/logs
# auth-profile lines + headless/visible mode) and prints a verdict block for a
# human/agent to judge. Honest: it never asserts a fix, only reports behavior.
#
# Usage:
#   bash scripts/repro/login-purge-repro.sh                 # public cookie test
#   bash scripts/repro/login-purge-repro.sh https://app.example.com/dashboard
#   UNBROWSE_BIN=./dist/unbrowse bash scripts/repro/login-purge-repro.sh
set -uo pipefail

UNBROWSE="${UNBROWSE_BIN:-unbrowse}"
URL="${1:-}"
LOGDIR="$HOME/.unbrowse/logs"
STAMP="$(date +%s 2>/dev/null || echo run)"
COOKIE_NAME="reprokey${STAMP}"
SA="lpr-a-$$"
SB="lpr-b-$$"

run() { timeout 120 "$UNBROWSE" "$@" 2>&1; }
have_cookie() { grep -qi "$COOKIE_NAME" <<<"$1" && echo yes || echo no; }

echo "================ login-purge repro ================"
echo "binary:   $(command -v "$UNBROWSE" 2>/dev/null || echo "$UNBROWSE")"
echo "version:  $(run --version 2>/dev/null | head -1)"
echo "mode:     $([ -n "$URL" ] && echo "AUTHED ($URL)" || echo "PUBLIC (httpbin cookie round-trip)")"
echo "settings: $(run settings 2>/dev/null | grep -oiE '"attach_existing_chrome"[^,]*|headless[^,]*' | head -2 | tr '\n' ' ')"
echo "logdir:   $LOGDIR"
SINCE_LOG="$(ls -t "$LOGDIR"/*.log 2>/dev/null | head -1)"
SINCE_LINES=$(wc -l < "$SINCE_LOG" 2>/dev/null || echo 0)
echo "---------------------------------------------------"

# --- vault-consistency check (the real bug surface, no browser needed) -------
# login-purge root cause (d32): kuri saveProfile writes the keychain secret
# first and the meta.json second; if the meta is lost, the cookies are orphaned
# (keychain entry present, meta absent) and loadProfile — which required the
# meta — failed, so auth was never restored => "constant logout". Detect those
# orphans directly. macOS keychain only; harmless elsewhere.
echo "--------------- vault consistency (orphan scan) ---------------"
KSVC="dev.justrach.kuri.auth-profile"
PROFILE_META_DIR="$HOME/.kuri/auth-profiles"
if command -v security >/dev/null 2>&1; then
  ACCTS=$(security dump-keychain 2>/dev/null | awk -v svc="$KSVC" '
    /"svce"<blob>=/ { if (index($0, svc)) svc_hit=1 }
    /"acct"<blob>=/ { a=$0; sub(/.*"acct"<blob>="/,"",a); sub(/".*/,"",a); acct=a }
    /^keychain:/ || /^class:/ { if (svc_hit && acct!="") print acct; svc_hit=0; acct="" }
    END { if (svc_hit && acct!="") print acct }' | sort -u)
  total=0; orphans=0
  while IFS= read -r dom; do
    [ -z "$dom" ] && continue
    total=$((total+1))
    safe=$(printf '%s' "$dom" | sed 's#[/\\ ]#_#g')
    if [ ! -f "$PROFILE_META_DIR/$safe.meta.json" ]; then
      orphans=$((orphans+1))
      [ $orphans -le 12 ] && echo "  ORPHAN (keychain has cookies, meta missing -> load fails): $dom"
    fi
  done <<< "$ACCTS"
  echo "  vault: $total saved domains, $orphans orphaned (would log out until the d32 loadProfile fix re-vendors)"
else
  echo "  (security CLI unavailable — non-macOS keychain backend; skip)"
fi
echo "--------------------------------------------------------------"

if [ -z "$URL" ]; then
  SET_URL="https://httpbin.org/cookies/set/${COOKIE_NAME}/reproval"
  CHECK_URL="https://httpbin.org/cookies"
else
  SET_URL="$URL"; CHECK_URL="$URL"
fi

echo "[session A] go -> $SET_URL"
run go "$SET_URL" --session "$SA" >/dev/null
A_COOKIES="$(run cookies --session "$SA")"
A_PAGE="$(run markdown --session "$SA" 2>/dev/null | head -40)"
echo "  cookies in A: $(grep -oiE '"name"[^,]*' <<<"$A_COOKIES" | head -8 | tr '\n' ' ')"
echo "  $COOKIE_NAME present in A: $(have_cookie "$A_COOKIES$A_PAGE")"
echo "[session A] close (saves auth profile)"
run close --session "$SA" >/dev/null

echo "[session B] fresh go -> $CHECK_URL"
run go "$CHECK_URL" --session "$SB" >/dev/null
B_COOKIES="$(run cookies --session "$SB")"
B_PAGE="$(run markdown --session "$SB" 2>/dev/null | head -40)"
B_HAS=$(have_cookie "$B_COOKIES$B_PAGE")
echo "  cookies in B: $(grep -oiE '"name"[^,]*' <<<"$B_COOKIES" | head -8 | tr '\n' ' ')"
echo "  $COOKIE_NAME persisted into B: $B_HAS"
run close --session "$SB" >/dev/null

echo "--------------- auth-profile log lines ---------------"
if [ -n "$SINCE_LOG" ]; then
  tail -n +$((SINCE_LINES+1)) "$SINCE_LOG" 2>/dev/null | grep -iE 'auth.?profile|loadAuthProfile|saveAuthProfile|cookie|purge|expire|delete' | tail -25 || echo "(no matching log lines)"
else
  echo "(no log file found under $LOGDIR)"
fi

echo "===================== VERDICT ====================="
if [ "$B_HAS" = "yes" ]; then
  echo "PERSISTED — the cookie survived the session round-trip."
  [ -z "$URL" ] && echo "Plain cookies are fine on this platform/mode. If you still get logged"
  [ -z "$URL" ] && echo "out, re-run with your AUTHED url — the bug is httpOnly/auth-cookie or"
  [ -z "$URL" ] && echo "concurrency-specific (run two sessions at once to test the clobber)."
else
  echo "LOST — the cookie did NOT persist. This reproduces the logout bug for"
  echo "this mode. Capture: the mode (headless/visible) + the auth-profile log"
  echo "lines above show whether save or load dropped it. This is the evidence"
  echo "needed to pinpoint + fix the mechanism."
fi
echo "==================================================="
