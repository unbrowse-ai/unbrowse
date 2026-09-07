#!/usr/bin/env bash
# Two-witness gate for the obscura browser backend.
#
# Proves — with a REAL network round-trip, no Chrome launched, no CDP socket —
# that unbrowse's two hardest browser needs are met by obscura's primitives:
#
#   W1  route capture : the obscura-capture sidecar (on_request/on_response)
#                       records a site's internal JSON API route WITH its body,
#                       and that body is collection-shaped (the cardinality gate).
#   W2  auth injection: a cookie "ripped from another browser", written in
#                       obscura's cookies.json shape by our jar writer, reaches
#                       the server through obscura (postman-echo echoes it back).
#
# Exit 0 only if BOTH witnesses pass. Fail-closed: any missing binary,
# non-zero sidecar exit, or absent marker fails the gate. Never a fabricated green.
#
# Binaries are resolved from env first so the gate runs identically in CI, in the
# repo, and against the scratchpad build:
#   OBSCURA_CAPTURE_BIN  path to the obscura-capture sidecar (required)
#   OBSCURA_BIN          path to the shipped obscura CLI     (required for W2)
set -uo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT


fail() { echo "GATE FAIL: $*" >&2; exit 1; }
command -v "$OBS" >/dev/null 2>&1 || [ -x "$OBS" ] || fail "obscura CLI not found (set OBSCURA_BIN)"
[ -x "$CAP" ] || fail "obscura-capture sidecar not found at $CAP (build it, or set OBSCURA_CAPTURE_BIN)"

echo "== W1: route capture via obscura primitives (no Chrome, no CDP) =="
# A public HTML page whose JS fires an internal JSON API on load. /scroll issues
# an XHR to /api/quotes?page=1 returning {"quotes":[...]} — a real "internal API
# behind the page", the exact thing unbrowse learns and replays.
W1_URL="https://quotes.toscrape.com/scroll"
"$CAP" "$W1_URL" --settle 5000 > "$work/w1.ndjson" 2> "$work/w1.err" || fail "sidecar exited non-zero (W1); stderr: $(cat "$work/w1.err")"

# Must have captured the internal API as an in-page fetch/XHR with a
# collection-shaped body (the cardinality gate: a net wants many fish).
python3 - "$work/w1.ndjson" <<'PY' || exit 1
import json, sys
rows = [json.loads(l) for l in open(sys.argv[1]) if l.strip()]
resp = [r for r in rows if r.get("kind") == "response"]
if not resp:
    print("GATE FAIL: sidecar captured zero responses", file=sys.stderr); sys.exit(1)
hit = None
for r in resp:
    if "/api/quotes" in r.get("url", "") and r.get("bodyText"):
        try:
            j = json.loads(r["bodyText"])
        except Exception:
            continue
        # collection-shaped: a top-level list, or an object carrying a non-empty list.
        coll = isinstance(j, list) or (
            isinstance(j, dict) and any(isinstance(v, list) and v for v in j.values())
        )
        if coll:
            hit = r; break
if not hit:
    print("GATE FAIL: no collection-shaped JSON API route captured; saw:", file=sys.stderr)
    for r in resp[:20]:
        print("   ", r.get("status"), r.get("resourceType"), r.get("url"), "bodyLen=", r.get("bodyLen"), file=sys.stderr)
    sys.exit(1)
print(f"  W1 PASS: captured {hit['method']} {hit['url']} [{hit['status']}] "
      f"as {hit['resourceType']}, collection body {hit['bodyLen']}B, "
      f"{len(resp)} total responses, Chrome never launched")
PY

echo "== W2: auth injection from another browser's jar (no Chrome, no CDP) =="
mkdir -p "$work/jar"
# Simulate the output of src/auth/obscura-jar.ts: a session cookie ripped from a
# real browser, written in obscura's exact camelCase cookies.json shape.
cat > "$work/jar/cookies.json" <<JSON
[{"name":"ripped_session","value":"FROM_REAL_BROWSER_$$","domain":"postman-echo.com","path":"/","secure":true,"httpOnly":true,"sameSite":"Lax","expires":9999999999}]
JSON
OUT="$("$OBS" fetch 'https://postman-echo.com/cookies' --storage-dir "$work/jar" --dump text --quiet 2>/dev/null)"
echo "  server saw: $OUT"
echo "$OUT" | grep -q "FROM_REAL_BROWSER_$$" || fail "injected cookie did not reach the server (W2)"
echo "  W2 PASS: injected auth reached the origin through obscura"

echo "== W3: interaction pass + JS-source endpoint discovery (no Chrome, no CDP) =="
# Exercises the sidecar's interaction flags (--scroll runs the click/scroll code
# path) AND proves discovery method (c): scanning obscura-captured JS/HTML source
# bodies surfaces an internal /api route candidate — the exact signal
# src/capture/bundle-scanner.ts (scanBundlesForRoutes) feeds to the direct-call
# gate in src/capture/obscura-index.ts. The ASSERTION is the deterministic
# source scan (not scroll-pagination, which a headless runtime may not fire); the
# interaction pass is exercised to prove it never breaks passive capture.
W3_URL="https://quotes.toscrape.com/scroll"
"$CAP" "$W3_URL" --settle 5000 --scroll 3 > "$work/w3.ndjson" 2> "$work/w3.err" || fail "sidecar exited non-zero (W3); stderr: $(cat "$work/w3.err")"
python3 - "$work/w3.ndjson" <<'PY' || exit 1
import json, re, sys
rows = [json.loads(l) for l in open(sys.argv[1]) if l.strip()]
resp = [r for r in rows if r.get("kind") == "response"]
# The interaction pass must not lose the passive collection capture.
if not any("/api/quotes" in r.get("url", "") and r.get("bodyText") for r in resp):
    print("GATE FAIL: interaction run lost the passive /api/quotes capture", file=sys.stderr); sys.exit(1)
# (c) discovery: scan captured JS/HTML source for an internal /api route literal.
pat = re.compile(r'''["'`](/api/[A-Za-z0-9/_-]{2,80})''')
cands = set()
for r in resp:
    ct = (r.get("contentType") or "").lower()
    b = r.get("bodyText") or ""
    if b and ("html" in ct or "javascript" in ct or "ecmascript" in ct):
        cands.update(m.group(1) for m in pat.finditer(b))
if "/api/quotes" not in cands:
    print("GATE FAIL: JS-source scan discovered no /api/quotes candidate; saw:", sorted(cands), file=sys.stderr)
    sys.exit(1)
print(f"  W3 PASS: interaction pass ran; JS-source discovery surfaced {sorted(cands)} from captured bodies")
PY

echo "GATE PASS: obscura primitives satisfy route-capture + auth-injection + interaction/JS-source discovery with no Chrome/CDP"
