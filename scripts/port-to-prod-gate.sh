#!/usr/bin/env bash
# port-to-prod-gate — the witness for the production port. Exits 0 ONLY when every
# authorized node of the north star is really settled. Each check is un-fakeable
# (real test run, real npm/prod/DB query, real scrub). Starts RED; goes green as
# the walk settles nodes. The public-facing surfaces (docs/frontend/readme/thin-CLI
# split) are staged to the Gitea mirror for review FIRST — this gate verifies they
# were pushed there and are scrub-clean, NOT that they were prod-deployed.
#
# Env (set when creds are available; each check fails honestly RED when unset):
#   PROD_BACKEND_URL   prod backend health endpoint base (e.g. https://api.unbrowse...)
#   DATABASE_URL       Neon prod connection string (for the indexed-data check)
#   PROD_NPM_VERSION   the version the prod release should publish to npm `latest`
#   INDEX_MIN_ROWS     min indexed rows expected in prod DB (default 1603 = real 10k oks)
set -uo pipefail
cd "$(dirname "$0")/.."
fail=0
note() { printf '  %s\n' "$1"; }

echo "=== 1. capture fixes (2 & 5) + forwarder-leak fix: tests green ==="
if bun test tests/direct-document-spa-hydration.test.ts tests/direct-document-fetch.test.ts \
     tests/kuri-proxy-forwarder-reap.test.ts >/tmp/port-gate-tests.log 2>&1; then
  note "ok — SPA-shell routing, parked fast-fail, forwarder reap all green"
else
  note "FAIL — see /tmp/port-gate-tests.log"; fail=1
fi

echo "=== 2. public-facing surfaces scrub-clean (prereq for Gitea + any public) ==="
if bash scripts/leak-guard.sh >/tmp/port-gate-leak.log 2>&1; then note "ok — leak-guard clean"; else note "FAIL — leak-guard (see /tmp/port-gate-leak.log)"; fail=1; fi
if [ -f scripts/public-scrub-gate.sh ]; then
  if bash scripts/public-scrub-gate.sh >/tmp/port-gate-scrub.log 2>&1; then note "ok — public-scrub clean"; else note "FAIL — public-scrub"; fail=1; fi
fi

echo "=== 3. backend + CLI shipped to PROD ==="
WANT_NPM="${PROD_NPM_VERSION:-}"
if [ -z "$WANT_NPM" ]; then note "PENDING — set PROD_NPM_VERSION to the released version"; fail=1; else
  L=$(npm view unbrowse dist-tags.latest 2>/dev/null || echo "")
  if [ "$L" = "$WANT_NPM" ]; then note "ok — unbrowse@$WANT_NPM on npm latest"; else note "PENDING — npm latest=$L want=$WANT_NPM"; fail=1; fi
fi
if [ -n "${PROD_BACKEND_URL:-}" ]; then
  if curl -fsS --max-time 15 "${PROD_BACKEND_URL%/}/health" >/dev/null 2>&1; then note "ok — prod backend health 200"; else note "FAIL — prod backend health"; fail=1; fi
else note "PENDING — set PROD_BACKEND_URL for the prod health check"; fail=1; fi

echo "=== 4. 10k indexed data transferred to Neon prod ==="
MIN_ROWS="${INDEX_MIN_ROWS:-1603}"
if [ -z "${DATABASE_URL:-}" ]; then note "PENDING — set DATABASE_URL (Neon prod) for the data-transfer check"; fail=1; else
  CNT=$(psql "$DATABASE_URL" -tAc "select count(*) from skills where source like 'index10k%' or skill_id like 'idx10k:%';" 2>/tmp/port-gate-db.log || echo "ERR")
  if [ "$CNT" = "ERR" ]; then note "FAIL — DB query errored (see /tmp/port-gate-db.log)"; fail=1
  elif [ "${CNT:-0}" -ge "$MIN_ROWS" ]; then note "ok — $CNT indexed rows in Neon prod (>= $MIN_ROWS)"; else note "PENDING — only $CNT indexed rows in prod (want >= $MIN_ROWS)"; fail=1; fi
fi

echo "=== 5. public-facing surfaces staged to Gitea mirror (your review before public) ==="
GITEA="${GITEA_BASE:-http://lewiss-mac-mini-1.tailce6bc6.ts.net:3000}"
BR="$(git rev-parse --abbrev-ref HEAD 2>/dev/null || echo HEAD)"
TOK="${GITEA_TOKEN:-$(security find-generic-password -a lekt8 -s GITEA_TOKEN -w 2>/dev/null || echo "")}"
if [ -z "$TOK" ]; then note "PENDING — no GITEA_TOKEN; cannot verify mirror push"; fail=1; else
  REMOTE_SHA=$(curl -fsS --max-time 15 -u "lekt8:$TOK" "$GITEA/api/v1/repos/lekt8/unbrowse/branches/$BR" 2>/dev/null | grep -oE '"id":"[0-9a-f]{40}"' | head -1 | grep -oE '[0-9a-f]{40}' || echo "")
  LOCAL_SHA=$(git rev-parse HEAD 2>/dev/null || echo "")
  if [ -n "$REMOTE_SHA" ] && [ "$REMOTE_SHA" = "$LOCAL_SHA" ]; then note "ok — Gitea mirror branch $BR at $LOCAL_SHA"; else note "PENDING — Gitea $BR=$REMOTE_SHA local=$LOCAL_SHA"; fail=1; fi
fi

echo
if [ "$fail" -ne 0 ]; then echo "[port-to-prod-gate] NOT YET — one or more nodes unsettled (see above)."; exit 1; fi
echo "[port-to-prod-gate] PASS — fixes shipped, data in prod, scrub-clean, mirror staged."; exit 0
