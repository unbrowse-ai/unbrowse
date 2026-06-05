#!/usr/bin/env bash
# ebm-runtime-ship-gate.sh — the witness that the CLOSED learned-ranker loop actually
# REACHES users, not just a source checkout. The bundled npm/worker build has no on-disk
# head pointer (flattened paths + vocab-scrub), so the head must travel as a compiled-in
# module. Exits 0 only when the loader returns a real head with NO file on disk.
set -uo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"; cd "$ROOT"
fail(){ echo "[ebm-ship] FAIL: $*"; exit 1; }
ok(){ echo "[ebm-ship] ok: $*"; }

EMB="src/ranking/signals/route-head.embedded.ts"
[ -s "$EMB" ] || fail "no embedded head module ($EMB)"
grep -q 'synthetic: false' "$EMB" || fail "embedded head is synthetic (must be a real, passing head)"
ok "embedded head module present and real"

# the loader falls back to the embedded head, named moat-cleanly (no internal vocab)
grep -q 'embeddedHead' src/ranking/signals/learned-energy.ts || fail "loader has no embedded fallback"
grep -qiE 'ebm|energy-based' "$EMB" && fail "embedded module name/contents leak internal vocab" || true
ok "loader wired to the embedded fallback (moat-clean)"

# THE proof: with NO on-disk pointer (the bundled-runtime condition), the loader still
# returns a real head — so the closed loop reaches CLI/npm/worker users.
bun -e '
import { learnedEnergy, __resetLearnedCache } from "./src/ranking/signals/learned-energy.ts";
process.env.UNBROWSE_EBM_HEAD = "/nonexistent/path/no-head-on-disk.json"; // simulate the bundle
__resetLearnedCache();
const warm = learnedEnergy("openlibrary.org","search.json","live-capture","get open library search results for dune");
const cold = learnedEnergy("brand-new-domain.xyz","api/v2/items","live-capture","search items for a query");
if (warm === null) { console.error("[ebm-ship] FAIL: loader null with no file on disk (head did NOT ship to the bundle)"); process.exit(1); }
if (cold === null) { console.error("[ebm-ship] FAIL: cold-cell null via embedded head"); process.exit(1); }
console.log("[ebm-ship] ok: bundled-runtime loader returns real head (warm="+warm.toFixed(4)+" cold="+cold.toFixed(4)+", back-off blind at 0.5)");
' 2>/dev/null || fail "embedded head does not load when no file is on disk"

# no regression: the closed-loop witness still green
bash bench/ebm-closed-loop-gate.sh >/dev/null 2>&1 || fail "ebm-closed-loop-gate regressed"
ok "closed-loop witness still green (no regression)"

echo "[ebm-ship] PASS — closed learned-ranker loop reaches the bundled runtime via embedded head"
exit 0
