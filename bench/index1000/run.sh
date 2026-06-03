#!/usr/bin/env bash
# index1000 — index a site list IN PARALLEL via the unbrowse binary, with AgentMail
# (plus-addressing on one inbox, since the account is at its inbox quota) as the email
# leg for any site that needs a signup. 80/20: feed the high-value head first.
#
#   bash bench/index1000/run.sh [sites.txt] [parallel]
# Env: UNBROWSE_BIN, AGENTMAIL_INBOX (default lekt9@agentmail.to), AGENTMAIL_API_KEY,
#      INDEX_OUT, PER_SITE_TIMEOUT.
#
# Resume-safe (skips sites already in the ledger), lazy/incremental (one JSONL row per
# site, flushed on completion — never holds state only in memory). This is the harness;
# the full 1000-site run is a fleet/CI campaign (real captures, hours) — see index-gate.sh.
set -uo pipefail
REPO="$(cd "$(dirname "$0")/../.." && pwd)"; cd "$REPO"
set -a; . ./.env 2>/dev/null || true; set +a

SITES="${1:-bench/index1000/sites.seed.txt}"
PAR="${2:-${INDEX_PARALLEL:-16}}"
OUT="${INDEX_OUT:-bench/index1000/.artifacts/index.jsonl}"
INBOX="${AGENTMAIL_INBOX:-lekt9@agentmail.to}"
BIN="${UNBROWSE_BIN:-bun src/cli.ts}"
TMO="${PER_SITE_TIMEOUT:-120}"
mkdir -p "$(dirname "$OUT")"; touch "$OUT"

index_one() {
  local url="$1"
  local host slug email t0 t1 raw ok
  host="$(printf '%s' "$url" | sed -E 's#^https?://##; s#/.*##')"
  slug="$(printf '%s' "$host" | tr '[:upper:]' '[:lower:]' | sed -E 's#[^a-z0-9]+#-#g; s#^-+|-+$##g')"
  # resume: skip sites already recorded
  grep -qF "\"site\":\"$url\"" "$OUT" 2>/dev/null && { echo "skip  $url"; return 0; }
  # per-site disposable identity via plus-addressing on the one inbox (quota workaround)
  email="${INBOX%@*}+${slug}@${INBOX#*@}"
  t0=$(date +%s)
  raw="$(AGENTMAIL_SIGNUP_EMAIL="$email" timeout "$TMO" $BIN run "$url" "index this site's main read API" --json 2>/dev/null || true)"
  t1=$(date +%s)
  if printf '%s' "$raw" | grep -qE '"success":true|"endpoint_id"|"skill_id"'; then ok=true; else ok=false; fi
  printf '{"site":"%s","slug":"%s","email":"%s","ok":%s,"ms":%s}\n' \
    "$url" "$slug" "$email" "$ok" "$(( (t1-t0)*1000 ))" >> "$OUT"
  echo "$([ "$ok" = true ] && echo ok || echo MISS)  $url  (${slug})"
}
export -f index_one; export OUT INBOX BIN TMO

echo "[index1000] $(grep -vcE '^\s*#|^\s*$' "$SITES") sites, parallel=$PAR, inbox=$INBOX -> $OUT"
grep -vE '^\s*#|^\s*$' "$SITES" | xargs -P "$PAR" -I{} bash -c 'index_one "$@"' _ {}
echo "[index1000] indexed ok=$(grep -c '"ok":true' "$OUT")/$(wc -l < "$OUT" | tr -d ' ')  (ledger: $OUT)"
