// Witness (Step 5, adversarial): the composite cascade folds EXACTLY the material inputs — a material
// change (method/url) invalidates, but NOISE (endpoint reorder, an unrelated endpoint change, a
// VOLATILE field like reliability_score/last_verified_at ticking) must NOT spuriously invalidate, or
// the composite cache would never hit in production. Chases the plan's named risk (too-many-inputs).
// Run: bun bench/capability/test_composite_cascade_adversarial.ts
process.env.UNBROWSE_LOCAL_CACHES = "1";
process.env.UNBROWSE_COMPOSITE_DIR = `/tmp/comp-adv-${process.pid}`;
import { writeComposite, readComposite, type PersistedComposite } from "../../src/orchestrator/index.ts";
import { rmSync } from "node:fs";

let fails = 0;
function ok(c: boolean, m: string) { if (!c) { console.error("  FAIL", m); fails++; } else console.log("  ok  ", m); }

const steps = [
  { endpoint_id: "login", ok: true, yielded: ["tok"] },
  { endpoint_id: "feed", ok: true, yielded: [] },
];
const edges = [{ from: "login", binding: "tok", to: "feed" }];
// Full endpoint objects (with volatile fields) — endpointContentHash must read ONLY id|method|url.
const ep = (id: string, url: string, reliability: number, verified: string): any =>
  ({ endpoint_id: id, method: "GET", url_template: url, reliability_score: reliability, last_verified_at: verified });
const baseEndpoints = [ep("login", "https://x.example/login", 0.5, "2026-06-01"), ep("feed", "https://x.example/feed", 0.5, "2026-06-01")];
// an UNRELATED endpoint present in the skill but not in the composite
const withUnrelated = [...baseEndpoints, ep("search", "https://x.example/search", 0.9, "2026-06-01")];

const c: PersistedComposite = {
  composite_id: "c1", intent_signature: "open feed", domain: "x.example", target: "feed",
  steps, edges, created_at: "2026-06-16T00:00:00Z",
};
writeComposite(c, baseEndpoints); // stamps content_id from base

// ── GOLDEN: unchanged endpoints → served ──
ok(!!readComposite("x.example", "feed", baseEndpoints), "golden: unchanged endpoints → composite served");

// ── EDGE 1 (no spurious): REORDER skill.endpoints → still served (content-id is order-independent) ──
ok(!!readComposite("x.example", "feed", [baseEndpoints[1], baseEndpoints[0]]), "EDGE reorder: endpoint array reordered → still served (no spurious invalidation)");

// ── EDGE 2 (no spurious): an UNRELATED endpoint added/changed → still served (not a constituent) ──
ok(!!readComposite("x.example", "feed", withUnrelated), "EDGE unrelated: an unrelated endpoint present → still served");
const unrelatedChanged = [baseEndpoints[0], baseEndpoints[1], ep("search", "https://x.example/search?v=2", 0.1, "2026-07-01")];
ok(!!readComposite("x.example", "feed", unrelatedChanged), "EDGE unrelated-changed: an unrelated endpoint's url/reliability changed → still served");

// ── ADVERSARIAL (the lost sheep): a VOLATILE field on a CONSTITUENT changed → must STILL serve ──
const volatileChanged = [
  ep("login", "https://x.example/login", 0.99 /* was 0.5 */, "2026-12-31" /* was 06-01 */),
  ep("feed", "https://x.example/feed", 0.01, "2026-12-31"),
];
ok(!!readComposite("x.example", "feed", volatileChanged),
   "ADVERSARIAL: a constituent's VOLATILE fields (reliability_score, last_verified_at) changed → STILL served (NOT spuriously invalidated — else the cache never hits)");

// ── MATERIAL change still invalidates (the cascade is real, not disabled) ──
const materialChanged = [ep("login", "https://x.example/login", 0.5, "2026-06-01"), ep("feed", "https://x.example/feed/v2", 0.5, "2026-06-01")];
ok(readComposite("x.example", "feed", materialChanged) === undefined,
   "MATERIAL: a constituent's url_template change → INVALIDATED (cascade still fires for real changes)");

try { rmSync(process.env.UNBROWSE_COMPOSITE_DIR!, { recursive: true, force: true }); } catch {}
console.log(fails === 0 ? "\nCOMPOSITE CASCADE ADVERSARIAL WITNESS PASSES (folds material, ignores noise)" : `\n${fails} FAILED`);
process.exit(fails === 0 ? 0 : 1);
