#!/usr/bin/env bash
# gate_durable.sh — the deterministic SHIPPED-BINARY robustness witness. A GUARANTEED-DEAD
# proxy is forced (UNBROWSE_KURI_PROXY=http://127.0.0.1:1); the capture must STILL return real
# data — proving the capture path detects the dead proxy (chrome-error:// / ERR_PROXY) and
# retries DIRECT instead of bricking. This is what makes the binary survive a flaky/dead
# residential-proxy upstream (the live failure that blocked bench axes B + C).
#
# RED until the fallback fix lands. Uses the npm-installed binary under test (UNBROWSE_BIN);
# rebuild it (npm run build:runtime && npm i -g .) after a src change so the witness sees it.
set -uo pipefail
BIN="${UNBROWSE_BIN:-/opt/nanobrew/prefix/bin/unbrowse}"
URL="https://old.reddit.com/r/rust/top.json?limit=5"

# clean slate so the binary can't attach to a surviving direct Chrome (would mask the test)
pkill -9 -f 'kuri' 2>/dev/null || true
pkill -9 -f 'remote-debugging-port' 2>/dev/null || true
sleep 2

out="$(UNBROWSE_KURI_PROXY='http://127.0.0.1:1' timeout 120 "$BIN" go "$URL" 2>/dev/null)"

echo "$out" | python3 -c "
import sys, re
raw = sys.stdin.read()
m = re.search(r'\"url\":\"([^\"]*)\"', raw)
u = m.group(1) if m else '?'
# escaping-robust: the page JSON is escaped inside the envelope (\\\"Listing\\\"), so match
# bare substrings. The navigation reaching the REAL url (not chrome-error) is the fallback proof.
real = ('chrome-error' not in u) and ('reddit.com' in u) and (
    'Listing' in raw or 'num_crossposts' in raw or 'children' in raw or len(raw) > 2000)
print('  gate_durable: capture under a FORCED-DEAD proxy → ' + ('GREEN (direct fallback — real data)' if real else f'RED (bricked: {u[:46]})'))
sys.exit(0 if real else 1)
"
