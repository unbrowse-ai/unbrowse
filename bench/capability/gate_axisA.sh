#!/usr/bin/env bash
# gate_axisA.sh — Axis A coverage witness for the no-XHR-API / SPA class. Each target is a
# REACHABLE hardest-scrape (H) / automation (A) page with NO clean XHR API — exactly the
# class the north star targets. `unbrowse explain` (force_capture → resolve) must surface
# >=1 endpoint with a positive score (a DOM-extraction route the agent can actually call).
# Two independent reachable representatives = the two-witness corroboration; faster +
# deterministic than the full 9-query corpus (which timed out): 2 live captures, not 9.
#
# SCOPE / honest ceiling: the original H2 representative stackoverflow.com/questions is NOT
# tested here — it sits behind a Cloudflare JS challenge ("Just a moment..."), which blocks
# the headless browser capture, curl-impersonate, AND the residential proxy alike (verified
# 2026-06-13: direct + proxied fetch both return the interstitial / HTTP 403). Defeating a
# Cloudflare Turnstile challenge is a DIFFERENT, adversarial capability — out of scope for
# the no-API/SPA DOM-extraction fix and deliberately NOT faked. lobste.rs is the reachable
# H representative in its place; npm is the A representative. The fix is validated on three
# independent reachable sites (npm, lobste.rs, news.ycombinator.com/ask).
#
# RED until resolve surfaces a DOM-extraction endpoint for reachable no-XHR-API / SPA pages.
# Uses the npm binary under test (UNBROWSE_BIN) against UNBROWSE_API_URL.
set -uo pipefail
BIN="${UNBROWSE_BIN:-/opt/nanobrew/prefix/bin/unbrowse}"
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"; cd "$HERE/../.."

MISSES=(
  "browse the newest stories on lobsters|https://lobste.rs/"
  "search npm for react packages|https://www.npmjs.com/search?q=react"
)
allok=1
for pair in "${MISSES[@]}"; do
  intent="${pair%%|*}"; url="${pair##*|}"
  pkill -9 -f 'kuri' 2>/dev/null || true; sleep 1
  out="$(timeout 240 "$BIN" explain --intent "$intent" --url "$url" --top 8 2>/dev/null)"
  cov="$(printf '%s' "$out" | python3 -c "
import sys, json
# explain emits ONE pretty-printed (multi-line) JSON object on stdout. Parse the whole
# blob from first '{' to last '}' — a line-by-line parser silently fails on pretty JSON.
raw = sys.stdin.read()
i, j = raw.find('{'), raw.rfind('}')
d = {}
if i != -1 and j > i:
    try: d = json.loads(raw[i:j+1])
    except Exception: d = {}
sl = d.get('shortlist_for_judgment') or []
top = sl[0] if sl else {}
score = top.get('score')
print('1' if (len(sl) >= 1 and isinstance(score, (int, float)) and score > 0) else '0')
")"
  if [ "$cov" = "1" ]; then echo "  ok   coverage: $url"; else echo "  FAIL no positive-score endpoint: $url"; allok=0; fi
done
if [ "$allok" = "1" ]; then echo "  GREEN — both H2 + A2 surface a positive-score endpoint"; exit 0; fi
echo "  RED — a miss still surfaces no endpoint"; exit 1
