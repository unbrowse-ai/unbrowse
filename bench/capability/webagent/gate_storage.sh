#!/usr/bin/env bash
# bench/capability/webagent/gate_storage.sh — the STORAGE / vault lever, gated.
#
# The bug the user screenshotted: a blocking macOS "Keychain Not Found" dialog for
# __unbrowse_vault_v1 froze the CLI. The fix pre-flights the keychain non-interactively
# and falls back to the encrypted FILE vault when it is unusable (UNBROWSE_NO_KEYCHAIN=1
# forces this path). This gate proves credentials still persist — and stay encrypted at
# rest — without ever touching the keychain:
#
#   WITNESS A (round-trip, keychain OFF): with UNBROWSE_NO_KEYCHAIN=1 and an isolated
#     HOME, storeCredential -> getCredential returns the EXACT secret. No keychain access,
#     no dialog: the file vault carries it. (The dialog can't fire because keytar is nulled.)
#   WITNESS B (encrypted at rest): the on-disk vault file (~/.unbrowse/vault/credentials.enc)
#     does NOT contain the cleartext secret — it is AES-sealed (iv+ciphertext). A grep for
#     the plaintext secret over the whole isolated HOME must find nothing.
#
# Exit: 0 when both witnesses pass; 1 if either fails (a real storage regression);
# 3 (BLOCKED) only if the toolchain can't run.
set -uo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$HERE/../../.." && pwd)"
cd "$ROOT"
TS="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
HISTORY="$ROOT/bench/capability/history.jsonl"

echo "── storage / vault gate (file-vault fallback, no keychain dialog) ──" >&2
if ! command -v bun >/dev/null 2>&1; then
  echo " GATE: BLOCKED — no bun toolchain"; exit 3
fi

G="$(mktemp -d)"
trap 'rm -rf "$G" 2>/dev/null' EXIT
VAULT_MOD="$ROOT/src/vault/index.ts"
SECRET="sk-live-storagelever-$$-$(date -u +%s)-ZZxQ"   # unique, unmistakable plaintext

# WITNESS A — store then retrieve through the file vault, keychain disabled.
A_OUT="$(HOME="$G" UNBROWSE_NO_KEYCHAIN=1 UNBROWSE_TELEMETRY=0 \
  __VM="$VAULT_MOD" __SECRET="$SECRET" timeout 60 bun -e '
import(process.env.__VM).then(async m=>{
  const acct = "storagelever-test-account";
  await m.storeCredential(acct, process.env.__SECRET);
  const got = await m.getCredential(acct);
  process.stdout.write(got === process.env.__SECRET ? "ROUNDTRIP_OK" : "ROUNDTRIP_MISMATCH:"+String(got).slice(0,12));
}).catch(e=>process.stdout.write("ROUNDTRIP_ERR:"+e))' 2>&1)"
WA="FAIL"
# The vault legitimately logs "[vault] macOS default keychain unavailable; using
# encrypted…" to stdout when it falls back — that log line is EXPECTED proof the
# fallback fired, not a failure. Grep for the marker token rather than exact-match,
# so the log preamble can't masquerade as a broken round-trip.
if echo "$A_OUT" | grep -q "ROUNDTRIP_OK"; then
  WA="PASS"; echo "  WA PASS — store->retrieve exact match via file vault (no keychain)" >&2
elif echo "$A_OUT" | grep -q "ROUNDTRIP_MISMATCH\|ROUNDTRIP_ERR"; then
  echo "  WA FAIL — round-trip did not match: $(echo "$A_OUT" | grep -o 'ROUNDTRIP_[A-Z_:].*' | head -c 70)" >&2
else
  echo "  WA FAIL — no round-trip marker in output: ${A_OUT:0:70}" >&2
fi

# WITNESS B — the secret must NOT sit in cleartext anywhere under the isolated HOME.
WB="FAIL"
if [ "$WA" = "PASS" ]; then
  if grep -rqF "$SECRET" "$G" 2>/dev/null; then
    HIT="$(grep -rlF "$SECRET" "$G" 2>/dev/null | head -1)"
    echo "  WB FAIL — cleartext secret found on disk: ${HIT#$G/}" >&2
  else
    WB="PASS"; echo "  WB PASS — secret is encrypted at rest (no cleartext under HOME)" >&2
  fi
else
  echo "  WB SKIP — round-trip failed, nothing trustworthy to scan" >&2
fi

echo "─────────────────────────────────────────────────"
echo " storage: roundtrip_no_keychain=$WA  encrypted_at_rest=$WB"
python3 -c "
import json
open('$HISTORY','a').write(json.dumps({'ts':'$TS','source':'live','axis':'storage',
  'roundtrip_no_keychain':'$WA','encrypted_at_rest':'$WB',
  'gate':'true' if ('$WA'=='PASS' and '$WB'=='PASS') else 'false'})+'\n')
"
if [ "$WA" = "PASS" ] && [ "$WB" = "PASS" ]; then
  echo " GATE: PASS — credentials persist via the encrypted file vault without the keychain dialog"
  exit 0
fi
echo " GATE: FAIL — storage/vault witness failed"
exit 1
