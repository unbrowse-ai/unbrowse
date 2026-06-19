#!/usr/bin/env bash
# research-gate.sh — runnable witness for the native `unbrowse research` primitive.
# Exits 0 EXACTLY when: (1) the no-fabrication/contract unit tests pass, AND (2) a live
# `unbrowse research` call returns op_kind eval:research with >=1 citation that is grounded
# in a really-fetched result (citation url ∈ results) and a non-empty answer. No fabricated green.
set -uo pipefail
cd "$(dirname "$0")/.." || exit 2

echo "[research-gate] 1/2 — unit invariants (no-fabrication, honest-empty, crash-safe)"
if ! bun test tests/research-primitive.test.ts >/tmp/rg-unit.log 2>&1; then
  echo "[research-gate] FAIL — unit tests red"; tail -5 /tmp/rg-unit.log; exit 1
fi
echo "[research-gate]   unit ok"

echo "[research-gate] 2/2 — live end-to-end (unbrowse research)"
OUT="$(timeout 90 bun src/cli.ts research "who founded Stripe" --json 2>/dev/null | grep -E '^\{' | tail -1)"
echo "$OUT" | python3 -c '
import sys, json
try:
    d = json.loads(sys.stdin.read())
except Exception as e:
    print("[research-gate] FAIL — no JSON:", str(e)[:60]); sys.exit(1)
ok = d.get("op_kind") == "eval:research"
cites = d.get("citations", []); results = d.get("results", [])
urls = {r.get("url") for r in results}
grounded = bool(cites) and all(c.get("url") in urls for c in cites)
answered = bool((d.get("answer") or "").strip())
print("  op_kind=%s cites=%d grounded=%s answered=%s" % (d.get("op_kind"), len(cites), grounded, answered))
sys.exit(0 if (ok and grounded and answered) else 1)
' || { echo "[research-gate] FAIL — live e2e did not satisfy the contract"; exit 1; }

echo "[research-gate] 3/3 — live extract (unbrowse extract, Tavily /extract parity)"
EOUT="$(timeout 60 bun src/cli.ts extract "https://en.wikipedia.org/wiki/Stripe,_Inc." --json 2>/dev/null | grep -E '^\{' | tail -1)"
echo "$EOUT" | python3 -c '
import sys, json
try:
    d = json.loads(sys.stdin.read())
except Exception as e:
    print("[research-gate] FAIL — extract no JSON:", str(e)[:60]); sys.exit(1)
ok = d.get("op_kind") == "eval:extract"
r = d.get("results", [])
good = len(r) == 1 and r[0].get("ok") is True and len((r[0].get("content") or "")) > 50
print("  op_kind=%s results=%d ok=%s content>50=%s" % (d.get("op_kind"), len(r), (r[0].get("ok") if r else None), good))
sys.exit(0 if (ok and good) else 1)
' || { echo "[research-gate] FAIL — extract did not satisfy the contract"; exit 1; }

echo "[research-gate] PASS — native research+extract primitives witnessed (unit + live grounded answer + batch extract)"
exit 0
