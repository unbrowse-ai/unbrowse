// Witness: a constituent value/definition change CASCADES to invalidate the cached composite — the
// /contract self-invalidation shape (Merkle content-id), no stale serve. Proves nodes 2,3,4. Run:
// bun bench/capability/test_composite_cascade_invalidation.ts
process.env.UNBROWSE_LOCAL_CACHES = "1";
process.env.UNBROWSE_COMPOSITE_DIR = `/tmp/comp-cascade-${process.pid}`;
import {
  writeComposite, readComposite, compositeContentId, endpointContentMap,
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
  { endpoint_id: "login", method: "POST", url_template: "https://x.example/login" },
  { endpoint_id: "feed", method: "GET", url_template: "https://x.example/feed" },
];
// epB: the feed endpoint's URL was re-captured differently (a constituent VALUE changed)
const epB = [
  { endpoint_id: "login", method: "POST", url_template: "https://x.example/login" },
  { endpoint_id: "feed", method: "GET", url_template: "https://x.example/feed?v=2" },
];

// ── NODE 2: Merkle-sensitivity — any constituent change flips the id; no change keeps it ──
const idA = compositeContentId("x.example", "feed", steps, edges, endpointContentMap(epA));
const idA2 = compositeContentId("x.example", "feed", steps, edges, endpointContentMap(epA));
const idB = compositeContentId("x.example", "feed", steps, edges, endpointContentMap(epB));
const idLoginChanged = compositeContentId("x.example", "feed", steps, edges,
  endpointContentMap([{ endpoint_id: "login", method: "PUT", url_template: "https://x.example/login" }, epA[1]]));
ok(idA === idA2, "Merkle: identical inputs → identical content-id (deterministic)");
ok(idB !== idA, "Merkle: a changed constituent (feed URL) → different content-id");
ok(idLoginChanged !== idA, "Merkle: a DIFFERENT constituent (login method) → different content-id (any input flips it)");

// ── NODE 3: readComposite cascade-invalidates on a constituent change ──
const c: PersistedComposite = {
  composite_id: "c1", intent_signature: "open feed", domain: "x.example", target: "feed",
  steps, edges, created_at: "2026-06-16T00:00:00Z",
};
writeComposite(c, epA); // stamps content_id from epA

ok(!!readComposite("x.example", "feed", epA), "hit: unchanged endpoints → composite served (content-id matches)");
ok(readComposite("x.example", "feed", epB) === undefined, "CASCADE: a changed constituent (feed URL) → composite INVALIDATED (not served stale)");
ok(!!readComposite("x.example", "feed"), "back-compat: no endpoints supplied → legacy behaviour (served, no validation)");

// ── NODE 3 fail-closed: a pre-Merkle composite (no content_id) is treated as stale ──
const cLegacy: PersistedComposite = { ...c, target: "legacy", content_id: undefined };
writeComposite(cLegacy); // NO endpoints → no content_id stamped
ok(readComposite("x.example", "legacy") !== undefined, "pre-Merkle: legacy read (no endpoints) still works");
ok(readComposite("x.example", "legacy", epA) === undefined, "fail-closed: pre-Merkle composite + validation requested → invalidated (re-walk once)");

// ── NODE 4: multi-level — a LEAF (login) change cascades up to invalidate the TOP composite (feed) ──
const epLeafChanged = [
  { endpoint_id: "login", method: "POST", url_template: "https://x.example/login/v2" }, // leaf re-captured
  epA[1],
];
ok(readComposite("x.example", "feed", epLeafChanged) === undefined,
   "CASCADE multi-level: a LEAF (login) definition change invalidates the TOP composite (feed), not just the leaf");

try { rmSync(process.env.UNBROWSE_COMPOSITE_DIR!, { recursive: true, force: true }); } catch {}
console.log(fails === 0 ? "\nCOMPOSITE CASCADE-INVALIDATION WITNESS PASSES" : `\n${fails} FAILED`);
process.exit(fails === 0 ? 0 : 1);
