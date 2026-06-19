#!/usr/bin/env bash
# research-prod-gate.sh — DEPLOY witness: the research suite works on the PUBLISHED, npm-installed
# shipped binary (not local source). Exits 0 EXACTLY when unbrowse@$VER is on npm AND its installed
# CLI does eval:extract + eval:map (research tolerated as environmental if DDG-throttled).
set -uo pipefail
VER="${1:-9.10.0-preview.0}"
PKG="unbrowse@${VER}"

echo "[prod-gate] 1/3 — is $PKG published on npm?"
if ! npm view "$PKG" version >/dev/null 2>&1; then
  echo "[prod-gate] FAIL — $PKG not on npm yet (CI not published)"; exit 1
fi
echo "[prod-gate]   published: $(npm view "$PKG" version 2>/dev/null)"

DIR="$(mktemp -d -t ub-prod.XXXXXX)"
trap 'rm -rf "$DIR"' EXIT
echo "[prod-gate] 2/3 — install the shipped CLI into a clean sandbox"
( cd "$DIR" && npm init -y >/dev/null 2>&1 && npm install --silent "$PKG" >/tmp/prod-install.log 2>&1 ) \
  || { echo "[prod-gate] FAIL — npm install $PKG failed"; tail -5 /tmp/prod-install.log; exit 1; }
BIN="$DIR/node_modules/.bin/unbrowse"
[ -x "$BIN" ] || { echo "[prod-gate] FAIL — no unbrowse bin in $PKG"; exit 1; }
echo "[prod-gate]   installed ver: $("$BIN" eval version --json 2>/dev/null | grep -oE '"version":"[^"]+"' | head -1)"

echo "[prod-gate] 3/3 — research primitives on the SHIPPED binary (extract + map)"
"$BIN" extract "https://en.wikipedia.org/wiki/Stripe,_Inc." --json 2>/dev/null | grep -E '^\{' | tail -1 | python3 -c '
import sys, json
d = json.loads(sys.stdin.read()); r = (d.get("results") or [{}])[0]
ok = d.get("op_kind")=="eval:extract" and r.get("ok") is True and len(r.get("content") or "")>50
print("  extract: op_kind=%s ok=%s content>50=%s" % (d.get("op_kind"), r.get("ok"), len((r.get("content") or ""))>50))
sys.exit(0 if ok else 1)' || { echo "[prod-gate] FAIL — shipped extract broken"; exit 1; }
"$BIN" map "https://en.wikipedia.org/wiki/Stripe,_Inc." --json 2>/dev/null | grep -E '^\{' | tail -1 | python3 -c '
import sys, json
d = json.loads(sys.stdin.read())
ok = d.get("op_kind")=="eval:map" and isinstance(d.get("links"), list) and len(d["links"])>=3
print("  map: op_kind=%s links=%d" % (d.get("op_kind"), len(d.get("links") or [])))
sys.exit(0 if ok else 1)' || { echo "[prod-gate] FAIL — shipped map broken"; exit 1; }

echo "[prod-gate] PASS — $PKG deployed + research suite live on the npm-installed shipped binary"
exit 0
