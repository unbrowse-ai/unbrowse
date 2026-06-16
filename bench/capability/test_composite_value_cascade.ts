// Witness: the value-water cascade — a constituent bound-VALUE change CASCADES to invalidate the
// cached composite (the Step-2 firmament: divided VALUE water, mirror of the SHAPE cascade). When
// currentValues are supplied, readComposite recomputes valueSetPointer and a mismatch (or a missing
// value_id) invalidates instead of serving stale; omitting them keeps shape-only back-compat. Run:
// bun bench/capability/test_composite_value_cascade.ts
process.env.UNBROWSE_LOCAL_CACHES = "1";
process.env.UNBROWSE_COMPOSITE_DIR = `/tmp/comp-value-cascade-${process.pid}`;
import {
  writeComposite, readComposite,
  type PersistedComposite,
} from "../../src/orchestrator/index.ts";
import { rmSync } from "node:fs";

let fails = 0;
function ok(c: boolean, m: string) { if (!c) { console.error("  FAIL", m); fails++; } else console.log("  ok  ", m); }

const steps = [
  { endpoint_id: "login", ok: true, yielded: ["tok"] },
  { endpoint_id: "feed", ok: true, yielded: [] },
];
const edges = [{ from: "login", binding: "tok", to: "feed" }];
const epA = [
  { endpoint_id: "login", method: "POST", url_template: "https://v.example/login" },
  { endpoint_id: "feed", method: "GET", url_template: "https://v.example/feed" },
];
// epB: the feed endpoint's URL was re-captured differently (a constituent SHAPE changed)
const epB = [
  { endpoint_id: "login", method: "POST", url_template: "https://v.example/login" },
  { endpoint_id: "feed", method: "GET", url_template: "https://v.example/feed?v=2" },
];

const c: PersistedComposite = {
  composite_id: "vc1", intent_signature: "open feed", domain: "v.example", target: "feed",
  steps, edges, created_at: new Date().toISOString(),
};
// Stamp BOTH waters: content_id from epA (shape) and value_id from these bound values (value).
writeComposite(c, epA, { tok: "abc", region: "us" });

// 1. unchanged shape AND unchanged value → served (both waters match)
ok(!!readComposite("v.example", "feed", epA, { tok: "abc", region: "us" }),
   "hit: unchanged endpoints + same bound values → composite served (shape and value both match)");

// 2. a bound VALUE changed → cascade-invalidate (value water diverged)
ok(readComposite("v.example", "feed", epA, { tok: "xyz", region: "us" }) === undefined,
   "VALUE CASCADE: a changed bound value (tok) → composite INVALIDATED (not served stale)");

// 3. the value SET changed (a key added) → cascade-invalidate
ok(readComposite("v.example", "feed", epA, { tok: "abc", region: "us", extra: "1" }) === undefined,
   "VALUE CASCADE: an added bound value (value set changed) → composite INVALIDATED");

// 4. back-compat: no currentValues supplied → value not checked, only shape (served)
ok(!!readComposite("v.example", "feed", epA),
   "back-compat: no currentValues supplied → value not checked, only shape → served");

// 5. fail-closed: a composite stamped WITHOUT bound values (no value_id) + value validation requested → invalidated
const cNoValue: PersistedComposite = { ...c, composite_id: "vc-nv", target: "novalue" };
writeComposite(cNoValue, epA); // endpoints only → content_id stamped, value_id ABSENT
ok(readComposite("v.example", "novalue", epA) !== undefined,
   "no-value composite: shape-only read (no currentValues) still works");
ok(readComposite("v.example", "novalue", epA, { tok: "abc" }) === undefined,
   "fail-closed: value validation requested but value_id absent → invalidated (re-walk once)");

// 6. regression: the SHAPE cascade still fires alongside the value cascade — a changed endpoint + same values → invalidate
ok(readComposite("v.example", "feed", epB, { tok: "abc", region: "us" }) === undefined,
   "SHAPE cascade still works alongside value cascade: changed feed URL (same values) → INVALIDATED");

// 7. both unchanged again → no spurious invalidation
ok(!!readComposite("v.example", "feed", epA, { tok: "abc", region: "us" }),
   "stability: unchanged shape + unchanged values re-read → served (no spurious invalidation)");

try { rmSync(process.env.UNBROWSE_COMPOSITE_DIR!, { recursive: true, force: true }); } catch {}
console.log(fails === 0 ? "\nCOMPOSITE VALUE-CASCADE WITNESS PASSES" : `\n${fails} FAILED`);
process.exit(fails === 0 ? 0 : 1);
