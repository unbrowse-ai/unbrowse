#!/usr/bin/env bash
# witness-wallet-test-isolation.sh — tests can NEVER read/mint/rotate the real
# self-custody wallet. The signer routes all wallet storage through an
# isolatable directory and skips the macOS keychain under isolation. GREEN
# requires ALL:
#   1. With UNBROWSE_WALLET_DIR=<temp>, ensureLocalWalletAddress() mints into the
#      temp dir (wallet.json + wallet.enc there) and the keychain is OFF — the
#      real ~/.unbrowse and the real key are provably untouched by that process.
#   2. UNBROWSE_DISABLE_KEYCHAIN=1 also turns the keychain off.
#   3. Default install (neither env set) keeps the keychain ON on macOS — i.e.
#      production behaviour is unchanged.
#   4. The bun test preload sets UNBROWSE_WALLET_DIR, so EVERY `bun test` run is
#      isolated by default (the fix that stops concurrent runs churning the key).
set -uo pipefail
cd "$(dirname "$0")/.."
fail(){ echo "WALLET-ISO RED: $1" >&2; exit 1; }
ENTRY=src/bin.ts; [ -f "$ENTRY" ] || ENTRY=src/cli.ts

T="$(mktemp -d)/wallet"; mkdir -p "$T"
echo "[1/4] UNBROWSE_WALLET_DIR isolates the mint + disables the keychain…"
OUT=$(UNBROWSE_WALLET_DIR="$T" bun -e '
import { ensureLocalWalletAddress, __internal } from "./src/values/signer.ts";
import { existsSync } from "node:fs";
import { join } from "node:path";
const addr = ensureLocalWalletAddress();
const dir = __internal.walletDir();
const out = {
  addr,
  dir,
  dir_is_temp: dir === process.env.UNBROWSE_WALLET_DIR,
  pointer_in_temp: existsSync(join(dir, "wallet.json")),
  enc_in_temp: existsSync(join(dir, "wallet.enc")),
  keychain_enabled: __internal.keychainEnabled(),
};
console.log(JSON.stringify(out));
' 2>/tmp/wiso.err) || { tail -8 /tmp/wiso.err; fail "isolated mint failed"; }
echo "    $OUT"
echo "$OUT" | grep -q '"dir_is_temp":true'     || fail "walletDir not the temp dir under UNBROWSE_WALLET_DIR"
echo "$OUT" | grep -q '"pointer_in_temp":true' || fail "wallet.json not written into the temp dir"
echo "$OUT" | grep -q '"enc_in_temp":true'     || fail "wallet.enc not written into the temp dir"
echo "$OUT" | grep -q '"keychain_enabled":false' || fail "keychain NOT disabled under isolation (would touch real key)"

echo "[2/4] UNBROWSE_DISABLE_KEYCHAIN=1 disables the keychain…"
KC=$(UNBROWSE_DISABLE_KEYCHAIN=1 bun -e 'import {__internal} from "./src/values/signer.ts"; console.log(__internal.keychainEnabled())' 2>/dev/null)
[ "$KC" = "false" ] || fail "UNBROWSE_DISABLE_KEYCHAIN=1 did not disable the keychain (got: $KC)"
echo "    keychain off: OK"

echo "[3/4] default install keeps the keychain ON (production unchanged)…"
if [ "$(uname)" = "Darwin" ]; then
  KCON=$(env -u UNBROWSE_WALLET_DIR -u UNBROWSE_DISABLE_KEYCHAIN bun -e 'import {__internal} from "./src/values/signer.ts"; console.log(__internal.keychainEnabled())' 2>/dev/null)
  [ "$KCON" = "true" ] || fail "default install lost the keychain (production regression): $KCON"
  echo "    keychain on by default (macOS): OK"
else
  echo "    non-macOS — keychain N/A, skipping"
fi

echo "[4/4] bun test preload isolates the wallet for every run…"
grep -q 'UNBROWSE_WALLET_DIR' tests/_setup.ts || fail "tests/_setup.ts does not set UNBROWSE_WALLET_DIR"
echo "    preload sets UNBROWSE_WALLET_DIR: OK"

echo "WALLET-ISO GREEN: tests are isolated from the real wallet + keychain; production keychain path intact"
