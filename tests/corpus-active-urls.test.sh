#!/usr/bin/env bash
# Falsifier for plan-v8 Phase C — auth-gated rows in
# scripts/corpus/hard-target-bench.txt are comment-prefixed and the bench
# parser at scripts/bench-two-phase.sh:276-280 honors that.
#
# Mirrors the bench's exact filter:
#   while IFS='|' read -r goal url; do
#     case "$goal" in ''|\#*) continue ;; esac
#     ...
#   done
#
# Run: bash tests/corpus-active-urls.test.sh
set -uo pipefail

CORPUS="scripts/corpus/hard-target-bench.txt"
PASS=0; FAIL=0
log() { printf "%s\n" "$*" >&2; }
ok()  { PASS=$((PASS+1)); log "  ok    $1"; }
err() { FAIL=$((FAIL+1)); log "  FAIL  $1: $2"; }

# Mirror bench parser exactly: skip empty + #-prefixed goals.
ACTIVE_URLS=()
ACTIVE_DOMAINS=()
while IFS='|' read -r goal url; do
  goal="${goal## }"; goal="${goal%% }"
  url="${url## }"; url="${url%% }"
  case "$goal" in ''|\#*) continue ;; esac
  [ -z "$url" ] && continue
  ACTIVE_URLS+=("$url")
  # Extract domain for blocklist check
  domain=$(printf '%s' "$url" | sed -E 's|^https?://([^/]+).*|\1|' | sed 's/^www\.//')
  ACTIVE_DOMAINS+=("$domain")
done < "$CORPUS"

# Falsifier 1: corpus has at least 20 active URLs (bench needs meaningful sample)
if [ "${#ACTIVE_URLS[@]}" -ge 20 ]; then
  ok "active-url-count: ${#ACTIVE_URLS[@]} URLs (>=20 required)"
else
  err "active-url-count" "only ${#ACTIVE_URLS[@]} active URLs (need >=20)"
fi

# Falsifier 2: tiktok/instagram/youtube auth-gated domains MUST NOT appear in active set
for blocklisted in tiktok.com instagram.com youtube.com; do
  found=0
  for d in "${ACTIVE_DOMAINS[@]}"; do
    if [ "$d" = "$blocklisted" ]; then
      found=1; break
    fi
  done
  if [ "$found" -eq 0 ]; then
    ok "auth-gated-excluded: $blocklisted is NOT in active corpus"
  else
    err "auth-gated-still-active-$blocklisted" "$blocklisted appears in active corpus despite Phase C"
  fi
done

# Falsifier 3: the comment header explaining the exclusion exists
if zigrep "Auth-gated SPA / GraphQL" "$CORPUS" >/dev/null 2>&1; then
  ok "exclusion-header: 'Auth-gated SPA / GraphQL' header present in corpus"
else
  err "exclusion-header" "header explaining the exclusion is missing — drift risk"
fi

# Falsifier 4: the 3 commented entries are still readable (preserved for future
# reference, not deleted) — `tiktok|`, `instagram|`, `youtube|` appear in the file
for site in tiktok instagram youtube; do
  if zigrep -i "${site}\.com" "$CORPUS" >/dev/null 2>&1; then
    ok "preserved-reference: $site.com still readable in corpus (commented)"
  else
    err "deleted-$site" "$site reference deleted — should be commented, not removed"
  fi
done

log ""
log "corpus-active-urls.test.sh: PASS=$PASS FAIL=$FAIL"
[ "$FAIL" -eq 0 ] || exit 1
