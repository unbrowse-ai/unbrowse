#!/usr/bin/env bash
# The local stand-in for promote.yml, for a repo whose GitHub Environments cannot deploy yet (no Cloudflare token
# there): staging goes to production when, and only when, the soak is clean and the staging gates passed on exactly
# the code in this checkout. Run it on a schedule after a staging deploy; it is safe to run again.
#   cd <repo> && CF_ENV_FILE=~/.config/…/x.env bash ~/.claude/skills/cf-release-train/scripts/promote-local.sh
# CF_ENV_FILE: a file with CLOUDFLARE_API_TOKEN and CLOUDFLARE_ACCOUNT_ID lines (read, never printed), unless both are
# already in the environment. Ends with one of:
#   PROMOTED …            production now runs what soaked (the DEPLOY_OK line follows)
#   ALREADY_PROMOTED …    this tested code was promoted by an earlier run
#   NOT_PROMOTED <why>    nothing was deployed (exit 1): the lines above say what is not ready
# Never between 23:45 and 06:00 local time: nobody is awake to see a production change (PROMOTE_ANY_HOUR=1 overrides).
# RELEASE_TRAIN_MANIFEST: promote the train of another manifest in the repo (one per Cloudflare account, say), e.g.
# .deploy/manifest.getfoundry.json. Every step then runs with --manifest, and the record of what was promoted is
# .deploy/.promoted.<name>. A manifest pinned to an account ("account") refuses the credentials of any other (ACCOUNT_FAIL).
#   cd <repo> && CLOUDFLARE_API_TOKEN=… CLOUDFLARE_ACCOUNT_ID=… RELEASE_TRAIN_MANIFEST=.deploy/manifest.x.json bash …/promote-local.sh
set -u
skill=$(dirname "$(readlink -f "$0")")
manifest=${RELEASE_TRAIN_MANIFEST:-.deploy/manifest.json}
train=$(basename "$manifest" .json); train=${train#manifest}; train=${train#.}
mf=(); [ "$manifest" = .deploy/manifest.json ] || mf=(--manifest "$manifest")
promoted=.deploy/.promoted${train:+.$train}
d() { node "${RELEASE_TRAIN_DEPLOY:-$skill/deploy.mjs}" "$@" ${mf[@]+"${mf[@]}"}; } # (a test swaps in a stand-in)
[ -f "$manifest" ] || { echo "NOT_PROMOTED no $manifest here: run it in the repo"; exit 1; }
# The file's token is for reading Cloudflare's records (the soak) and is given to that step alone: the deploy runs on
# whatever this machine deploys with already. Handed to every step, a read-only token would have been used for the
# production deploy too, and refused (found before the first real promotion, 2026-11-13).
soak_token=${CLOUDFLARE_API_TOKEN:-}; soak_account=${CLOUDFLARE_ACCOUNT_ID:-}
if [ -n "${CF_ENV_FILE:-}" ] && [ -f "${CF_ENV_FILE/#\~/$HOME}" ]; then
  f=${CF_ENV_FILE/#\~/$HOME}
  v=$(grep -m1 "^CLOUDFLARE_API_TOKEN=" "$f" | cut -d= -f2- | tr -d "\"'"); [ -n "$v" ] && soak_token=$v
  v=$(grep -m1 "^CLOUDFLARE_ACCOUNT_ID=" "$f" | cut -d= -f2- | tr -d "\"'"); [ -n "$v" ] && soak_account=$v
fi
tested=$(d gated staging | tail -1)
case "$tested" in GATED_OK*) ;; *) echo "NOT_PROMOTED ${tested:-the staging gates have no pass on record}"; exit 1 ;; esac
stamp=$(echo "$tested" | grep -oE 'at=[^ ]+')
if [ -f "$promoted" ] && grep -qF "$stamp" "$promoted"; then echo "ALREADY_PROMOTED $(cat "$promoted")"; exit 0; fi
now=${PROMOTE_NOW_HHMM:-$(date +%H%M)}
if [ -z "${PROMOTE_ANY_HOUR:-}" ] && { [ "$now" -ge 2345 ] || [ "$now" -lt 0600 ]; }; then echo "NOT_PROMOTED it is ${now:0:2}:${now:2:2}: production waits for the morning"; exit 1; fi
soak=$(CLOUDFLARE_API_TOKEN=$soak_token CLOUDFLARE_ACCOUNT_ID=$soak_account d soak staging 2>&1)
echo "$soak" | grep -E '^(FAIL|SOAK_|ACCOUNT_FAIL)' | cut -c1-240
echo "$soak" | grep -q '^SOAK_ALL_OK' || { echo "NOT_PROMOTED staging has not soaked clean (the FAIL lines above)"; exit 1; }
out=$(d production 2>&1); code=$?
echo "$out" | grep -E '^(ok  |FAIL|deployed|DEPLOY_|ACCOUNT_FAIL)' | cut -c1-240
if [ $code -eq 0 ] && echo "$out" | grep -q '^DEPLOY_OK env=production'; then
  echo "$stamp promoted=$(date -Is) $(git rev-parse --short HEAD 2>/dev/null)" > "$promoted"
  echo "PROMOTED $(cat "$promoted")"; exit 0
fi
echo "$out" | tail -15 | cut -c1-240
echo "NOT_PROMOTED the production deploy or its gate failed (a failed gate rolls production back: see DEPLOY_FAIL above)"; exit 1
