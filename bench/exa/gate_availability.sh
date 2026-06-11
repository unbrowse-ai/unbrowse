#!/usr/bin/env bash
# Witness for the availability gap: a throttled host whose probe times out
# (no race winner) must still be served by OUR pipeline (direct-document via the
# impersonate->proxy ladder) through the full `unbrowse search` path — NOT dropped
# to exa, NOT empty. Exits 0 iff the no-winner-branch fix works AND a healthy host
# still resolves (no regression). Proxy creds auto-read from ~/.identity/iproyal-creds.
set -uo pipefail
cd "$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"   # repo root
export UNBROWSE_MARKDOWN_BUDGET="${UNBROWSE_MARKDOWN_BUDGET:-200000}"

# host -> required outcome. docs.redhat.com = anti-bot host that 403s plain curl
# and was dropped to exa (empty); the curl-impersonate (Chrome JA4) rung in
# direct-document recovers it DETERMINISTICALLY (no proxy needed). This is the
# reproducible witness of the availability fix. requests.readthedocs = healthy
# control (must stay served, no regression).
#
# NOTE (honest, not gated): IP-throttled hosts like gnu.org are also recovered by
# the direct->proxy escalation rung (resolveEgressProxy / IPRoyal), but residential
# proxy latency on multi-MB manuals is variable (5s..>45s), so that path is
# best-effort and NOT a gate condition — gating on external proxy variance would
# be a green-by-luck, not a witnessed capability.
THROTTLED="https://docs.redhat.com/es/documentation/red_hat_jboss_enterprise_application_platform/7.4/html-single/developing_hibernate_applications/index"
HEALTHY="https://requests.readthedocs.io/en/latest/"

source_of() {
  timeout 80 unbrowse search --intent "document contents" --url "$1" --budget 40000 2>/dev/null \
  | grep '^{' | python3 -c "
import json,sys
obj=None
for l in sys.stdin.read().splitlines():
    l=l.strip()
    if l.startswith('{') and l.endswith('}'):
        try:
            o=json.loads(l)
            if isinstance(o,dict) and isinstance(o.get('result'),dict): obj=o
        except Exception: pass
if not obj: print('EMPTY'); sys.exit(0)
r=obj['result']
print(('REJECTED' if r.get('rejected') else (obj.get('source') or '?')) + f\" md={len(r.get('markdown') or '')}\")
"
}

fail=0
th="$(source_of "$THROTTLED")"
echo "throttled (docs.redhat 403->impersonate): $th"
case "$th" in
  direct-document*) echo "  ok: served by our pipeline" ;;
  *) echo "  FAIL: throttled host not served by direct-document (dropped to exa/empty)"; fail=1 ;;
esac

he="$(source_of "$HEALTHY")"
echo "healthy  (readthedocs): $he"
case "$he" in
  direct-document*|marketplace*) echo "  ok: healthy host still served" ;;
  *) echo "  FAIL: healthy host regressed"; fail=1 ;;
esac

if [ "$fail" -eq 0 ]; then echo "GATE PASS: availability gap closed"; exit 0; fi
echo "GATE FAIL: availability gap open"; exit 1
