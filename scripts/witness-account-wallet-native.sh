#!/usr/bin/env bash
# witness-account-wallet-native.sh — onboarding is native + zero-step: a fresh
# install ALWAYS surfaces a self-custody identity wallet through `unbrowse
# account`, with no `setup`/`register` run first. GREEN requires ALL:
#   1. In a brand-new HOME, `unbrowse account --json` (nothing else run) returns
#      a real base58 wallet_address, wallet_provider="unbrowse-local",
#      identity_wallet==wallet_address, and it matches the auto-minted
#      ~/.unbrowse/wallet.json pointer (so the user can identify their wallet).
#   2. The pristine-machine contract is preserved: with
#      UNBROWSE_DISABLE_LOCAL_WALLET=1 the account view reports no wallet (tests
#      that assert a clean machine still pass).
# Tests whatever `unbrowse` is installed (override with UNBROWSE_BIN).
set -uo pipefail
cd "$(dirname "$0")/.."
fail(){ echo "ACCOUNT-WALLET RED: $1" >&2; exit 1; }
UB="${UNBROWSE_BIN:-/opt/nanobrew/prefix/bin/unbrowse}"
[ -x "$UB" ] || UB="$(command -v unbrowse)" || fail "no unbrowse binary"

clean(){ J="$1"; echo "$J" | grep -vE "ToS check|rehydrated|Still working|^\[" | grep '{' | tail -1; }

# 1) zero-step native onboarding
H1="$(mktemp -d)/home"; mkdir -p "$H1"
echo "[1/2] fresh HOME, no setup/register → account surfaces a wallet…"
RAW="$(HOME="$H1" timeout 60 "$UB" account --json 2>&1)"
J="$(clean "$RAW")"
[ -n "$J" ] || { echo "$RAW" | tail -5; fail "no account JSON"; }
ADDR=$(echo "$J" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const j=JSON.parse(s);console.log(j.wallet_address||"")})')
PROV=$(echo "$J" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const j=JSON.parse(s);console.log(j.wallet_provider||"")})')
IDW=$(echo "$J"  | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const j=JSON.parse(s);console.log(j.identity_wallet||"")})')
echo "    wallet_address=$ADDR provider=$PROV identity=$IDW"
[ -n "$ADDR" ] || fail "wallet_address is empty (user can't identify their wallet)"
echo "$ADDR" | grep -qE '^[1-9A-HJ-NP-Za-km-z]{32,44}$' || fail "wallet_address not a base58 Solana address: $ADDR"
[ "$PROV" = "unbrowse-local" ] || fail "wallet_provider != unbrowse-local: $PROV"
[ "$IDW" = "$ADDR" ] || fail "identity_wallet != wallet_address ($IDW vs $ADDR)"
PTR=$(node -e "console.log(require('$H1/.unbrowse/wallet.json').address)" 2>/dev/null) || fail "wallet.json not auto-minted by account"
[ "$PTR" = "$ADDR" ] || fail "account address ($ADDR) != wallet.json pointer ($PTR)"
echo "    auto-minted + surfaced + matches pointer: OK"

# 1b) STABILITY: a second `account` must return the SAME address — `account` is a
# query, it reads the existing identity and must NEVER rotate it (regression guard:
# calling ensure-mint on every account would re-mint if storage hiccups).
J2RUN="$(clean "$(HOME="$H1" timeout 60 "$UB" account --json 2>&1)")"
ADDR_AGAIN=$(echo "$J2RUN" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const j=JSON.parse(s);console.log(j.wallet_address||"")})')
[ "$ADDR_AGAIN" = "$ADDR" ] || fail "account rotated the identity wallet on a repeat call ($ADDR -> $ADDR_AGAIN)"
echo "    repeat account is stable (no rotation): OK"

# 2) pristine-machine contract preserved
H2="$(mktemp -d)/home"; mkdir -p "$H2"
echo "[2/2] UNBROWSE_DISABLE_LOCAL_WALLET=1 → no wallet (pristine contract)…"
J2="$(clean "$(HOME="$H2" UNBROWSE_DISABLE_LOCAL_WALLET=1 timeout 60 "$UB" account --json 2>&1)")"
ADDR2=$(echo "$J2" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const j=JSON.parse(s);console.log(j.wallet_address===null?"NULL":(j.wallet_address||""))})')
[ "$ADDR2" = "NULL" ] || fail "disable flag should leave wallet_address null, got: $ADDR2"
[ -f "$H2/.unbrowse/wallet.json" ] && fail "disable flag should NOT mint a wallet"
echo "    pristine machine yields no wallet: OK"

echo "ACCOUNT-WALLET GREEN: native zero-step onboarding surfaces a self-custody wallet; pristine contract intact"
