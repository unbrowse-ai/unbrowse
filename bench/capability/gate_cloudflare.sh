#!/usr/bin/env bash
# gate_cloudflare.sh — the HARD ceiling witness: a Cloudflare-JS-challenge page
# (stackoverflow.com/questions, "Just a moment…") must be DEFEATED — `unbrowse explain`
# must surface a positive-score endpoint AND the capture must have reached REAL content
# (not the interstitial). This is the witness for the Scrapling-primitive yoink
# (camoufox stealth engine + solve_cloudflare loop + fingerprint hardening).
#
# UNGAMEABLE BY DESIGN:
#   - Coverage alone is necessary but NOT sufficient: the run must also show a real-capture
#     SUCCESS marker in stderr (a rescue/extraction success), AND must NOT terminate on a
#     Cloudflare block. Our capture detects "just a moment" and routes it to the block
#     ladder, and the page_fetch fallback is gated on trace.success — so a bare interstitial
#     cannot mint coverage. This gate adds the content-reached assertion on top.
#   - The extracted content must carry real Stack Overflow Q&A signal and must NOT be the
#     interstitial ("just a moment" / "enable javascript and cookies").
#
# RED until a stealth capture (camoufox) actually clears the challenge. Honest negative
# until then — Cloudflare is adversarial; this gate is not guaranteed to ever go green and
# must never be faked. Uses the npm binary under test (UNBROWSE_BIN) against UNBROWSE_API_URL.
set -uo pipefail
BIN="${UNBROWSE_BIN:-/opt/nanobrew/prefix/bin/unbrowse}"
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"; cd "$HERE/../.."

INTENT="browse the latest questions on stack overflow"
URL="https://stackoverflow.com/questions"

pkill -9 -f 'kuri' 2>/dev/null || true; sleep 1
ERR="$(mktemp)"; OUT="$(mktemp)"
timeout 300 "$BIN" explain --intent "$INTENT" --url "$URL" --top 8 2>"$ERR" >"$OUT"

# (1) coverage: >=1 endpoint with positive score
cov="$(python3 -c "
import sys, json
raw = open('$OUT').read()
i, j = raw.find('{'), raw.rfind('}')
d = json.loads(raw[i:j+1]) if (i != -1 and j > i) else {}
sl = d.get('shortlist_for_judgment') or []
top = sl[0] if sl else {}
print('1' if (len(sl) >= 1 and isinstance(top.get('score'), (int, float)) and top.get('score') > 0) else '0')
")"

# (2) real content reached: a rescue/extraction SUCCESS marker fired this run, and the run
#     did not end on a still-blocked Cloudflare signal.
reached="$(python3 -c "
import re
e = open('$ERR').read().lower()
success = bool(re.search(r'_success:|dom-fallback\] extracted \d{3,}|camoufox_success|ssr_fastpath_success|curl_cffi_success', e))
still_blocked_terminal = ('just a moment' in e) or ('enable javascript and cookies' in e)
print('1' if (success and not still_blocked_terminal) else '0')
")"

rm -f "$ERR" "$OUT"
if [ "$cov" = "1" ] && [ "$reached" = "1" ]; then
  echo "  GREEN — stackoverflow (Cloudflare) defeated: endpoint surfaced + real content reached"
  exit 0
fi
echo "  RED — cloudflare ceiling holds (cov=$cov reached_real_content=$reached)"
exit 1
