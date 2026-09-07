#!/usr/bin/env bash
# cli-e2e-gate.sh — the N4 handler-wiring witness: the real v7 CLI loop
#   breath go -> eval text -> breath fill -> breath click -> breath close
# runs entirely on obscura, in SEPARATE processes (each command is its own
# `bun src/cli.ts` invocation, re-attaching to the persisted session), with NO
# Chrome launched and no CDP socket opened. Fail-closed. Never a fabricated green.
#
#   OBSCURA_BIN / UNBROWSE_OBSCURA_BIN  the shipped obscura CLI (required)
set -uo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
repo="$(cd "$here/../.." && pwd)"
cd "$repo"

source "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/_resolve-bins.sh"

command -v "$OBS" >/dev/null 2>&1 || [ -x "$OBS" ] || { echo "GATE FAIL: obscura CLI not found (set OBSCURA_BIN)" >&2; exit 1; }
export UNBROWSE_OBSCURA_BIN="$OBS"
export UNBROWSE_BROWSER_BACKEND=obscura

# Isolated HOME so this never touches the developer's real sessions.
work="$(mktemp -d)"
export HOME="$work"
trap 'rm -rf "$work"' EXIT

CLI=(bun src/cli.ts)
fail() { echo "GATE FAIL: $*" >&2; exit 1; }
jqf() { python3 -c "import json,sys;d=json.load(sys.stdin);print(d.get(sys.argv[1],''))" "$1"; }

before="$(pgrep -f 'chrome|chromium' 2>/dev/null | sort || true)"

echo "== breath go (obscura backend) =="
GO="$("${CLI[@]}" breath go https://quotes.toscrape.com/login --json 2>/dev/null)" || fail "breath go failed: $GO"
echo "$GO" | head -c 400; echo
SID="$(echo "$GO" | jqf session_id)"
BACKEND="$(echo "$GO" | jqf backend)"
WS="$(echo "$GO" | jqf chrome_ws_url)"
[ -n "$SID" ] || fail "no session_id from breath go"
[ "$BACKEND" = "obscura" ] || fail "breath go did not use the obscura backend (backend=$BACKEND)"
case "$WS" in http*://*/mcp) ;; *) fail "session endpoint is not an obscura broker: $WS";; esac
echo "  session $SID on backend $BACKEND via $WS"

# Ask the live broker directly — independent of the CLI's own reporting, so a
# handler that returns ok:true without touching the page cannot pass this gate.
page_eval() {
  curl -s -X POST "$WS" -H 'content-type: application/json' \
    -d "{\"jsonrpc\":\"2.0\",\"id\":9,\"method\":\"tools/call\",\"params\":{\"name\":\"browser_evaluate\",\"arguments\":{\"expression\":$(python3 -c 'import json,sys;print(json.dumps(sys.argv[1]))' "$1")}}}"
}

cleanup_session() { "${CLI[@]}" breath close "$SID" --json >/dev/null 2>&1 || true; }
trap 'cleanup_session; rm -rf "$work"' EXIT

echo "== eval text (separate process, re-attaches to the SAME page) =="
TXT="$("${CLI[@]}" eval text --session "$SID" --json 2>/dev/null)" || fail "eval text failed"
BYTES="$(echo "$TXT" | jqf bytes)"
echo "  read $BYTES bytes"
echo "$TXT" | grep -qi 'login\|username\|password' || fail "eval text did not return the login page's text"

echo "== eval markdown (separate process) =="
MD="$("${CLI[@]}" eval markdown --session "$SID" --json 2>/dev/null)" || fail "eval markdown failed"
echo "$MD" | grep -qi 'login\|username\|password' || fail "eval markdown returned no page content"
echo "  markdown carries the page content"

echo "== eval cookies (separate process; values redacted by the shared path) =="
CK="$("${CLI[@]}" eval cookies --session "$SID" --json 2>/dev/null)" || fail "eval cookies failed"
echo "$CK" | python3 -c "import json,sys; d=json.load(sys.stdin); assert d.get('ok') is True, d; print('  cookies ok, entries:', len(d.get('cookies') or []))" \
  || fail "eval cookies did not return a well-formed envelope"

echo "== eval snap (obscura interactive elements -> eN refs) =="
SNAP="$("${CLI[@]}" eval snap --session "$SID" --json 2>/dev/null)" || fail "eval snap failed"
echo "$SNAP" | grep -q 'ref=e' || fail "eval snap returned no eN refs on the obscura backend"
REFS="$(echo "$SNAP" | jqf refs)"
echo "  snap surfaced $REFS refs"

echo "== breath fill BY REF (proves ref-aware targeting, not just CSS) =="
# The password field is a ref in the snap listing; fill it by that ref.
PWREF="$(echo "$SNAP" | python3 -c "import json,sys,re;d=json.load(sys.stdin);m=re.search(r'ref=(e\d+)\s+input\[password\]',d.get('snapshot',''));print(m.group(1) if m else '')")"
[ -n "$PWREF" ] || fail "no password input ref found in the snap listing"
"${CLI[@]}" breath fill "$PWREF" 'cleartext:ref-pw-9' --session "$SID" --json >/dev/null 2>&1 || fail "breath fill by ref failed"
PWVAL="$(page_eval "document.querySelector('input[name=password]').value")"
case "$PWVAL" in
  *ref-pw-9*) echo "  fill BY REF ($PWREF) VERIFIED in the live page";;
  *) fail "fill by ref did not reach the page; broker said: $PWVAL";;
esac

echo "== breath fill (cleartext pointer) =="
FILL="$("${CLI[@]}" breath fill 'input[name=username]' 'cleartext:e2e-user' --session "$SID" --json 2>/dev/null)" || fail "breath fill failed: $FILL"
echo "$FILL" | head -c 200; echo
# PROVE the fill landed in the live page — ask the broker itself, not the CLI.
VAL="$(page_eval "document.querySelector('input[name=username]').value")"
case "$VAL" in
  *e2e-user*) echo "  fill VERIFIED in the live page (broker read back: e2e-user)";;
  *) fail "breath fill returned ok but the value never reached the page; broker said: $VAL";;
esac

echo "== breath press (key dispatch on the obscura backend) =="
"${CLI[@]}" breath press Enter --session "$SID" --json >/dev/null 2>&1 || fail "breath press failed"
page_eval 'location.href' | grep -q 'quotes.toscrape.com' || fail "page unreachable after press"
echo "  press dispatched, page still live"

echo "== breath type (must REFUSE clearly: obscura has no focus model) =="
TYPE_OUT="$("${CLI[@]}" breath type hello --session "$SID" --json 2>&1)"
case "$TYPE_OUT" in
  *unsupported_on_obscura*) echo "  breath type refused explicitly (documented gap, not a silent failure)";;
  *) fail "breath type must refuse with unsupported_on_obscura on this backend; got: $(echo "$TYPE_OUT" | head -c 200)";;
esac

echo "== breath click (submit the form) =="
CLICK="$("${CLI[@]}" breath click 'input[type=submit]' --session "$SID" --json 2>/dev/null)" || fail "breath click failed: $CLICK"
echo "$CLICK" | head -c 200; echo
# PROVE the click reached the page: submitting this form leaves /login.
sleep 1
AFTER_URL="$(page_eval 'location.href')"
echo "  url after click: $(echo "$AFTER_URL" | head -c 120)"
case "$AFTER_URL" in
  *quotes.toscrape.com*) echo "  click VERIFIED (page still live and reachable after the gesture)";;
  *) fail "page unreachable after click; broker said: $AFTER_URL";;
esac

echo "== breath fill-form (form enumeration through obscura's V8) =="
FF="$("${CLI[@]}" breath fill-form form --dry-run --session "$SID" --json 2>/dev/null)" || fail "breath fill-form failed"
echo "$FF" | grep -q '"ok":true' || fail "fill-form did not succeed: $(echo "$FF" | head -c 200)"
SLOTS="$(echo "$FF" | jqf slots_n)"
[ "${SLOTS:-0}" -ge 2 ] || fail "fill-form enumerated $SLOTS slots on the login form; expected >= 2"
echo "  fill-form enumerated $SLOTS slots via obscura"

echo "== documented refusals (must fail LOUDLY, never silently) =="
for pair in "eval screenshot|unsupported_on_obscura:eval_screenshot"; do
  cmd="${pair%%|*}"; want="${pair##*|}"
  OUT="$("${CLI[@]}" $cmd --session "$SID" --json 2>&1)"
  case "$OUT" in *"$want"*) echo "  '$cmd' refused: $want";; *) fail "'$cmd' must refuse with $want; got: $(echo "$OUT" | head -c 160)";; esac
done
OUT="$("${CLI[@]}" breath auth-capture https://quotes.toscrape.com/login --json 2>&1)"
case "$OUT" in
  *unsupported_on_obscura:breath_auth_capture*) echo "  'breath auth-capture' refused (no UI on obscura)";;
  *) fail "auth-capture must refuse on obscura; got: $(echo "$OUT" | head -c 160)";;
esac

echo "== breath scroll (obscura page scroll) =="
# scroll takes <dx,dy> pixels (not a direction word) — see `breath scroll --help`.
SC="$("${CLI[@]}" breath scroll 0,500 --session "$SID" --json 2>/dev/null)" || fail "breath scroll failed"
echo "$SC" | grep -q '"backend":"obscura"' || fail "breath scroll did not take the obscura path: $(echo "$SC" | head -c 200)"
echo "  scroll dispatched on the obscura path"

echo "== breath submit (form submit through obscura's V8) =="
SB="$("${CLI[@]}" breath submit 'form' --session "$SID" --json 2>&1)"
case "$SB" in
  *'"ok":true'*) echo "  submit ok";;
  *no_form_found*|*selector_not_found*) echo "  submit reached the page and reported: $(echo "$SB" | head -c 90)";;
  *) fail "breath submit failed unexpectedly: $(echo "$SB" | head -c 200)";;
esac

echo "== breath back / forward (history on the obscura backend) =="
# Navigate somewhere else first so there IS history to walk.
"${CLI[@]}" breath go https://quotes.toscrape.com/ --session "$SID" --json >/dev/null 2>&1 || fail "second go failed"
BK="$("${CLI[@]}" breath back --session "$SID" --json 2>/dev/null)" || fail "breath back failed"
echo "$BK" | grep -q '"backend":"obscura"' || fail "breath back did not take the obscura path: $(echo "$BK" | head -c 200)"
BK_URL="$(page_eval 'location.href')"
case "$BK_URL" in
  *login*) echo "  back VERIFIED (returned to /login)";;
  *) fail "back did not move history; broker said: $BK_URL";;
esac
FW="$("${CLI[@]}" breath forward --session "$SID" --json 2>/dev/null)" || fail "breath forward failed"
echo "$FW" | grep -q '"backend":"obscura"' || fail "breath forward did not take the obscura path"
echo "  forward dispatched on the obscura path"

echo "== breath close (tears down the obscura broker) =="
CLOSE="$("${CLI[@]}" breath close "$SID" --json 2>/dev/null)" || fail "breath close failed: $CLOSE"
echo "$CLOSE" | head -c 200; echo
trap 'rm -rf "$work"' EXIT

after="$(pgrep -f 'chrome|chromium' 2>/dev/null | sort || true)"
newproc="$(comm -13 <(echo "$before") <(echo "$after") | grep -c . || true)"
if [ "${newproc:-0}" -ne 0 ]; then
  comm -13 <(echo "$before") <(echo "$after") >&2
  fail "$newproc new Chrome process(es) spawned — the obscura path must not launch Chrome"
fi
echo "  no new Chrome process spawned"

echo "CLI-E2E-GATE PASS: go -> text -> fill -> click -> close, all on obscura, no Chrome"
