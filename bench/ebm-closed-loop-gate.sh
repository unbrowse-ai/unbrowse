#!/usr/bin/env bash
# ebm-closed-loop-gate.sh — the witness that the EBM self-learning loop is CLOSED
# on real data, not synthetic. Exits 0 only when every link is real:
#   intent wired -> real traces carry it -> trainer fits a real head that
#   generalises on cold cells -> a non-synthetic head ships -> the prod loader
#   loads it (non-null). Plus the prior deploy/self-improve witnesses stay green.
set -uo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"; cd "$ROOT"
fail(){ echo "[ebm-loop] FAIL: $*"; exit 1; }
ok(){ echo "[ebm-loop] ok: $*"; }

# 1. intent is wired into the live scoring call site (was dropped → dead features)
# NB: .* not [^)]* — the call casts an arg ((ep as {...}).source) carrying an inner ')', so a
# [^)]* regex false-negatives even though intent IS the final arg (index.ts:7045). The real
# condition is "intent is the last argument to routeEnergy"; .* spans the inner paren.
grep -qE 'routeEnergy\(.*,[[:space:]]*intent[[:space:]]*\)' src/execution/index.ts \
  || fail "src/execution/index.ts no longer passes intent into routeEnergy (dead n-gram features)"
ok "intent wired into the live ranker call site"

# 2. the loader reads intent from the trace's real key (goal), not a phantom key
grep -qE 'r\.get\("intent"\)[[:space:]]*or[[:space:]]*r\.get\("goal"' scripts/ebm/ledger_ebm.py \
  || fail "ledger_ebm.py does not read intent from the real trace key (goal)"
ok "trainer reads intent from the real trace key"

# 3. the real ledger is intent-bearing (not 100% empty)
INTENT_PCT=$(python3 - <<'PY'
import sys; sys.path.insert(0,"scripts/ebm")
from ledger_ebm import load_real_ledger
r=load_real_ledger()
ne=sum(1 for x in r if x["intent"].strip())
print(0 if not r else round(100*ne/len(r)))
PY
)
[ "${INTENT_PCT:-0}" -ge 50 ] || fail "real ledger intent coverage ${INTENT_PCT}% (<50% — features still dead)"
ok "real ledger intent coverage ${INTENT_PCT}%"

# 4. the trainer fits a REAL head that clears the bar (cold-cell generalisation or lift)
python3 scripts/ebm/layer3_train.py --real --quiet || fail "layer3_train.py --real did not pass (no real head shipped)"
ok "layer3 trainer passed on the real ledger"

# 5. a non-synthetic head is the live pointer, and it carries real cold-cell value
python3 - <<'PY' || exit 1
import json,sys
try: d=json.load(open("bench/ebm/energy-head.latest.json"))
except Exception: print("[ebm-loop] FAIL: no energy-head.latest.json shipped"); sys.exit(1)
if d.get("synthetic"): print("[ebm-loop] FAIL: live head is synthetic"); sys.exit(1)
ac=d.get("auc_cold_cells")
if ac is None or ac < 0.53: print(f"[ebm-loop] FAIL: cold-cell AUC {ac} < 0.53 (no real generalisation)"); sys.exit(1)
print(f"[ebm-loop] ok: real head shipped, cold-cell AUC {ac} (back-off blind there)")
PY

# 6. the production loader actually LOADS the real head (non-null) — loop closed at runtime
bun -e '
import { learnedEnergy } from "./src/ranking/signals/learned-energy.ts";
const v = learnedEnergy("openlibrary.org","search.json","live-capture","get open library search results for dune");
if (v === null) { console.error("[ebm-loop] FAIL: loader returned null (head not loaded in prod path)"); process.exit(1); }
console.log("[ebm-loop] ok: prod loader loads the real head (learnedEnergy="+v.toFixed(4)+")");
' 2>/dev/null || fail "prod loader did not load the real head"

# 7. do not regress the prior witnesses (deploy + 20-iteration self-improvement)
bash bench/self-improve-gate.sh >/dev/null 2>&1 || fail "self-improve-gate regressed"
ok "prior witnesses (deploy + 20 self-improvement iterations) still green"

echo "[ebm-loop] PASS — EBM self-learning loop is CLOSED on real data, loader loads it, no regressions"
exit 0
