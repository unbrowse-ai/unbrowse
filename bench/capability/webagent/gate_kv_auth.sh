#!/usr/bin/env bash
# bench/capability/webagent/gate_kv_auth.sh — the AUTH-BOUND KV lever, gated.
#
# The concern (user): the data-bearing caches must be bound to the verified auth principal,
# or one caller's authenticated entry can be replayed to another (cross-tenant leak). This
# gate witnesses that the two data-bearing layers — the resolution cache and the session
# yield store — are partitioned per principal:
#
#   WITNESS 1 (cross-auth isolation test): tests/kv-auth-binding.test.ts — a two-sided
#     falsifier. SAME principal HITS (the cache works), DIFFERENT principal + anon MISS (the
#     isolation holds), for both the resolution cache and the yield store, plus the wired
#     credentialFromAuthHeaders path (same session_id, different auth_headers → no leak).
#   WITNESS 2 (mutation guard): neutralize the principal binding (key ignores principal) and
#     re-run — the isolation test MUST go RED. A binding that can't be falsified is painted;
#     this proves the witness actually bites. The source is restored before the gate returns.
#
# Exit: 0 iff the isolation test is GREEN bound AND RED when the binding is removed; 1 if the
# test fails bound (real regression) or survives the mutation (painted); 3 if no toolchain.
set -uo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$HERE/../../.." && pwd)"
cd "$ROOT"
TS="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
HISTORY="$ROOT/bench/capability/history.jsonl"
RUNNER="${UNBROWSE_TEST_RUNNER:-bun test}"
SRC="src/values/cached-resolution.ts"
TESTF="tests/kv-auth-binding.test.ts"

echo "── auth-bound KV gate (resolution cache + yield store) ──" >&2
if ! command -v bun >/dev/null 2>&1; then echo " GATE: BLOCKED — no bun toolchain"; exit 3; fi

green() { timeout 120 $RUNNER "$TESTF" >/dev/null 2>&1; }   # rc 0 == all pass

# WITNESS 1 — bound: the isolation test passes.
W1="FAIL"; if green; then W1="PASS"; echo "  W1 PASS — cross-auth isolation test green (bound)" >&2; else echo "  W1 FAIL — isolation test red while bound (real regression)" >&2; fi

# WITNESS 2 — mutation: remove the binding, the test MUST fail; then restore.
W2="FAIL"; BAK="$(mktemp)"; cp "$SRC" "$BAK"
python3 - "$SRC" <<'PY'
import re,sys
p=sys.argv[1]; s=open(p).read()
n=re.sub(r'return principal === undefined \? key : .*?;','return key;',s,count=1,flags=re.S)
open(p,"w").write(n); print("mutated" if n!=s else "NOMATCH")
PY
if green; then
  echo "  W2 FAIL — isolation test still PASSED with the binding removed (painted/tautology)" >&2
else
  W2="PASS"; echo "  W2 PASS — removing the binding turns the test RED (true falsifier)" >&2
fi
cp "$BAK" "$SRC"; rm -f "$BAK"   # restore the real source
# sanity: confirm the restore brought it back green
green && echo "  restore OK — source green again" >&2 || echo "  WARN — source not green after restore" >&2

echo "─────────────────────────────────────────────────"
echo " kv_auth: bound_green=$W1  mutation_red=$W2"
python3 -c "
import json
open('$HISTORY','a').write(json.dumps({'ts':'$TS','source':'live','axis':'kv_auth_binding',
  'bound_green':'$W1','mutation_red':'$W2',
  'gate':'true' if ('$W1'=='PASS' and '$W2'=='PASS') else 'false'})+'\n')
"
if [ "$W1" = "PASS" ] && [ "$W2" = "PASS" ]; then
  echo " GATE: PASS — data-bearing KV is bound to the verified auth principal; isolation is a true falsifier"
  exit 0
fi
echo " GATE: FAIL — auth-bound KV witness failed (regression bound, or painted under mutation)"
exit 1
