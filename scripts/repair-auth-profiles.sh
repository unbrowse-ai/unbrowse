#!/usr/bin/env bash
# repair-auth-profiles.sh — recover orphaned auth logins (login-purge).
#
# Root cause (d32): kuri saveProfile writes the keychain secret first and the
# meta.json second; when the meta is lost the cookies are orphaned — the secret
# sits in the keychain but loadProfile (which requires the meta) can't find it,
# so the user is logged out though the cookies are right there. On one real
# machine 150 of 155 saved domains were orphaned.
#
# This regenerates the missing meta.json for every keychain auth-profile that
# lacks one. ADDITIVE + reversible (it only writes metadata kuri needs to find
# EXISTING cookies — it never touches the cookies/keychain or deletes anything).
# The CURRENT runtime's loadProfile then finds them (it reads the keychain by
# meta.name), so logins are restored immediately, without a kuri re-vendor. The
# durable prevention (loadProfile falling back to the keychain when the meta is
# missing) ships with the next kuri release.
#
# macOS keychain backend only. No-op elsewhere.
set -uo pipefail
KSVC="dev.justrach.kuri.auth-profile"
META_DIR="$HOME/.kuri/auth-profiles"
NOW="$(date +%s)"
DRY="${DRY_RUN:-0}"

if ! command -v security >/dev/null 2>&1; then
  echo "repair-auth-profiles: SKIP (no macOS security CLI — different backend)"; exit 0
fi
mkdir -p "$META_DIR"

ACCTS=$(security dump-keychain 2>/dev/null | awk -v svc="$KSVC" '
  /"svce"<blob>=/ { if (index($0, svc)) svc_hit=1 }
  /"acct"<blob>=/ { a=$0; sub(/.*"acct"<blob>="/,"",a); sub(/".*/,"",a); acct=a }
  /^keychain:/ || /^class:/ { if (svc_hit && acct!="") print acct; svc_hit=0; acct="" }
  END { if (svc_hit && acct!="") print acct }' | sort -u)

total=0; repaired=0
while IFS= read -r dom; do
  [ -z "$dom" ] && continue
  total=$((total+1))
  safe=$(printf '%s' "$dom" | sed 's#[/\\ ]#_#g')
  meta="$META_DIR/$safe.meta.json"
  if [ ! -f "$meta" ]; then
    repaired=$((repaired+1))
    if [ "$DRY" = "1" ]; then
      echo "  would repair: $dom"
    else
      printf '{"name":"%s","origin":"https://%s","saved_at":%s,"backend":"keychain"}\n' "$dom" "$dom" "$NOW" > "$meta"
    fi
  fi
done <<< "$ACCTS"

echo "repair-auth-profiles: $total saved domains, $repaired $([ "$DRY" = 1 ] && echo "would be " )recovered (meta regenerated)"
