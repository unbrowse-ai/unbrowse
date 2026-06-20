#!/usr/bin/env bash
# Paper-gap gate — the falsifiable LIGHT over the gap ledger (Gen 1:14).
# Re-verifies each documented "say vs do" gap LIVE. Exit 0 = the audit is still
# TRUE (every documented gap still holds). A gap that has CLOSED flips its line to
# CLOSED and the gate exits 1 — a GOOD signal: progress that must be folded into the
# ledger (Luke 15:4, go after the one that changed). Never a fabricated green.
set -uo pipefail
cd "$(dirname "$0")/../.." || exit 2
ROOT="$(pwd)"
set -a; source "$ROOT/.env" 2>/dev/null; source "$ROOT/backend/.env" 2>/dev/null; set +a
holds=0; closed=0; unknown=0

check() { # name | "HOLDS"|"CLOSED"|"UNKNOWN" | detail
  case "$2" in
    HOLDS)   holds=$((holds+1));   printf "  GAP HOLDS   | %-22s | %s\n" "$1" "$3" ;;
    CLOSED)  closed=$((closed+1)); printf "  GAP CLOSED! | %-22s | %s\n" "$1" "$3" ;;
    *)       unknown=$((unknown+1)); printf "  UNKNOWN     | %-22s | %s\n" "$1" "$3" ;;
  esac
}

# Gap 1 — index DATA-EMPTY: bm25-idx empty on prod + staging.
idx_found=""
if [ -n "${EMERGENTDB_API_KEY:-}" ]; then
  for kv in "skills-v2:bm25-idx:v2-global" "staging-skills-v3:bm25-idx:stg2-global"; do
    enc=$(python3 -c "import urllib.parse,sys;print(urllib.parse.quote(sys.argv[1]))" "$kv")
    f=$(curl -s -m6 -H "Authorization: Bearer $EMERGENTDB_API_KEY" "https://api.emergentdb.com/qdkv/get/$enc" 2>/dev/null | python3 -c "import sys,json;print(json.load(sys.stdin).get('found'))" 2>/dev/null)
    idx_found="$idx_found$f "
  done
  if echo "$idx_found" | grep -q "True"; then check "index" CLOSED "bm25-idx now has data ($idx_found) — index populating!"; else check "index" HOLDS "bm25-idx found=False prod+staging ($idx_found)"; fi
else check "index" UNKNOWN "EMERGENTDB_API_KEY unset — cannot probe qdkv"; fi

# Gap 2 — passive-index MOAT-ONLY: /reveng behind requireSignedClient.
if git grep -qE "requireSignedClient" backend/src/routes/reveng.ts 2>/dev/null; then
  check "passive-index" HOLDS "/reveng requireSignedClient = OFFICIAL-BUILD gate (release-signed); non-official builds 426. anon identity OK"
else check "passive-index" CLOSED "requireSignedClient removed from /reveng — passive path may be open"; fi

# Gap 3 — FLEX/x402 settlement DEVNET-ONLY: no mainnet settlement path.
if git grep -qiE "devnet-only" scripts/flex-devnet-settle.mjs 2>/dev/null && ! git grep -qiE "mainnet-beta.*flex|flex.*mainnet-beta" scripts/ backend/src/ 2>/dev/null; then
  check "flex-settlement" HOLDS "FLEX program devnet-only; no mainnet settlement path"
else check "flex-settlement" CLOSED "a FLEX mainnet path appeared — verify settlement"; fi

# Gap 4 — composite DISK-TIER persist FLAG-OFF (UNBROWSE_LOCAL_CACHES). NOTE: only the
# local-disk tier is off; the MAIN in-memory + KV replay is ON by default (orchestrator !=="0").
if git grep -qE 'UNBROWSE_LOCAL_CACHES.*!==.*"1"|UNBROWSE_LOCAL_CACHES.*!= *.1.' src/ 2>/dev/null; then
  check "composite-disk-tier" HOLDS "composite DISK-TIER default-OFF (UNBROWSE_LOCAL_CACHES !==1); main in-mem+KV replay ON by default (!==0)"
else check "composite-disk-tier" UNKNOWN "UNBROWSE_LOCAL_CACHES guard not found — re-check default"; fi

echo "── paper-gap gate ── HOLDS=$holds CLOSED=$closed UNKNOWN=$unknown"
if [ "$closed" -gt 0 ]; then
  echo "GATE: a documented gap has CLOSED — update the ledger (good news, but the audit is now stale). exit 1"
  exit 1
fi
if [ "$holds" -ge 3 ] && [ "$unknown" -le 1 ]; then
  echo "GATE PASS — the audit is still true: documented gaps verified live, none silently closed. exit 0"
  exit 0
fi
echo "GATE: too many UNKNOWN — cannot stand the audit on rock. exit 2"; exit 2
