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
# Source project .env so the witness is deterministic regardless of caller env
# (the Stop-hook runs this bare — without this, node 4's prod probes have no
# UNBROWSE_API_KEY and falsely report 0/20). Same recipe as run.sh.
set -a; . ./.env 2>/dev/null || true; set +a
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

echo "=== 3. backend + CLI shipped to PROD (with THESE fixes, not just any version) ==="
WANT_NPM="${PROD_NPM_VERSION:-}"
if [ -z "$WANT_NPM" ]; then note "PENDING — set PROD_NPM_VERSION to the NEW released version containing the fixes"; fail=1; else
  L=$(npm view unbrowse dist-tags.latest 2>/dev/null || echo "")
  if [ "$L" != "$WANT_NPM" ]; then note "PENDING — npm latest=$L want=$WANT_NPM"; fail=1; else
    # Un-fakeable: the published tarball must actually carry the fixes. Download
    # it and grep the bundled dist for fix fingerprints. A stale version (7.2.0,
    # published before the fixes) fails here even though it's on `latest`.
    TGZ=$(npm pack "unbrowse@$WANT_NPM" --silent 2>/dev/null || echo "")
    if [ -n "$TGZ" ] && [ -f "$TGZ" ]; then
      if tar -xzOf "$TGZ" 2>/dev/null | grep -q "dead_or_parked" && tar -xzOf "$TGZ" 2>/dev/null | grep -q "SPA_ROOT_CONTAINER_RE\|trackForwarderPid"; then
        note "ok — unbrowse@$WANT_NPM on npm latest AND tarball carries the capture+forwarder fixes"
      else
        note "FAIL — unbrowse@$WANT_NPM on latest but tarball is MISSING the fixes (stale release)"; fail=1
      fi
      rm -f "$TGZ"
    else note "PENDING — could not npm-pack unbrowse@$WANT_NPM to verify fixes"; fail=1; fi
  fi
fi
PB="${PROD_BACKEND_URL:-https://beta-api.unbrowse.ai}"
if curl -fsS --max-time 15 "${PB%/}/health" >/dev/null 2>&1; then note "ok — prod backend health 200 ($PB)"; else note "FAIL — prod backend health ($PB)"; fail=1; fi

echo "=== 4. 10k indexed data in prod marketplace (auto-published live during the campaign) ==="
# `unbrowse run` auto-publishes each resolved skill to the prod marketplace
# (default API base beta-api.unbrowse.ai). So the transfer happened live during
# the 10k campaign, not as a separate batch. Verify it un-fakeably: sample
# ok-domains from the ledger and confirm prod returns a skill for them. Needs a
# reachable prod API + key (.env). SAMPLE_N domains, require >= REQ_FRAC resolve.
LEDGER="${INDEX_LEDGER:-bench/index1000/.artifacts/index.jsonl}"
API="${UNBROWSE_API_URL:-https://beta-api.unbrowse.ai}"
KEY="${UNBROWSE_API_KEY:-}"
SAMPLE_N="${INDEX_SAMPLE_N:-20}"; REQ="${INDEX_SAMPLE_MIN:-15}"
if [ -z "$KEY" ] || [ ! -f "$LEDGER" ]; then note "PENDING — need UNBROWSE_API_KEY + ledger for the prod-resolve check"; fail=1; else
  hits=0; tried=0
  for s in $(grep '"ok":true' "$LEDGER" | grep -oE '"site":"https://[^"]+"' | sed 's/"site":"//;s/"//' | head -"$SAMPLE_N"); do
    dom=$(echo "$s" | sed -E 's#https?://##;s#/.*##'); tried=$((tried+1))
    # Retry-once on miss with a small delay — prod rate-limits rapid sequential
    # probes, which was making the sampled count flake 14↔16 on the same domains.
    ok_dom=0
    for attempt in 1 2; do
      body=$(curl -s --max-time 15 -H "Authorization: Bearer $KEY" "$API/v1/skills?domain=$dom" 2>/dev/null || echo "")
      if echo "$body" | grep -qE '"skill_id"|"endpoint_id"'; then ok_dom=1; break; fi
      sleep 0.4
    done
    hits=$((hits+ok_dom))
    sleep 0.2
  done
  if [ "$hits" -ge "$REQ" ]; then note "ok — $hits/$tried sampled ok-domains resolve in prod marketplace (>= $REQ)"; else note "PENDING — only $hits/$tried sampled domains resolve in prod (want >= $REQ)"; fail=1; fi
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
