#!/usr/bin/env bash
# login-purge-gate.sh — witness: no orphaned auth profiles (keychain entry with
# a missing meta.json, which made loadProfile fail -> "constant logout"). The
# d32 repair regenerated the missing metas; the durable kuri loadProfile fix
# (keychain fallback) prevents recurrence on the next re-vendor. macOS-keychain
# specific; skips cleanly elsewhere (the bug is keychain-backend only).
set -uo pipefail
KSVC="dev.justrach.kuri.auth-profile"; MD="$HOME/.kuri/auth-profiles"
command -v security >/dev/null 2>&1 || { echo "login-purge-gate: SKIP (no macOS keychain backend)"; exit 0; }
ACCTS=$(security dump-keychain 2>/dev/null | awk -v svc="$KSVC" '/"svce"<blob>=/{if(index($0,svc))h=1} /"acct"<blob>=/{a=$0;sub(/.*"acct"<blob>="/,"",a);sub(/".*/,"",a);acct=a} /^keychain:/||/^class:/{if(h&&acct!="")print acct;h=0;acct=""} END{if(h&&acct!="")print acct}' | sort -u)
[ -z "$ACCTS" ] && { echo "login-purge-gate: SKIP (no kuri auth-profiles saved on this host)"; exit 0; }
o=0; while IFS= read -r d; do [ -z "$d" ]&&continue; s=$(printf '%s' "$d"|sed 's#[/\\ ]#_#g'); [ ! -f "$MD/$s.meta.json" ]&&o=$((o+1)); done <<<"$ACCTS"
if [ "$o" -eq 0 ]; then echo "login-purge-gate: ok — no orphaned auth profiles"; exit 0; fi
echo "login-purge-gate: FAIL — $o orphaned auth profile(s) (run scripts/repair-auth-profiles.sh)"; exit 1
