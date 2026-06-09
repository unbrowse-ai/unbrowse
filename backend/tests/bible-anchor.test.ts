import { test, expect, mock } from "bun:test";

// Witness for the internal bible-anchor ordering organ. The substrate
// (/graph/search) is mocked — these prove the anchor parsing, the apophenia
// confidence gate, and the NON-DESTRUCTIVE sequencing contract (set preserved,
// only order changes, and only on high confidence).

// Canned chapter "search" results keyed by a substring of the query.
function fakeResult(idx: number, ref: string, score: number) {
  return { results: [{ id: `ch-${String(idx).padStart(4, "0")}`, score, metadata: { idx, ref } }] };
}

const ROUTER: Array<{ match: string; idx: number; ref: string; score: number }> = [
  { match: "create", idx: 0, ref: "Genesis 1", score: 0.82 },
  { match: "begin", idx: 0, ref: "Genesis 1", score: 0.80 },
  { match: "love", idx: 1100, ref: "1 John 4", score: 0.78 },
  { match: "shepherd", idx: 500, ref: "Psalms 23", score: 0.40 }, // weak anchor
  { match: "tax", idx: 700, ref: "Matthew 22", score: 0.41 },
];

mock.module("../src/services/emergentdb.js", () => ({
  emergentDBRequest: async (_env: unknown, _m: string, path: string, body: { query?: string }) => {
    if (path !== "/graph/search") return {};
    const q = (body.query ?? "").toLowerCase();
    const hit = ROUTER.find((r) => q.includes(r.match));
    if (!hit) return { results: [] };
    return fakeResult(hit.idx, hit.ref, hit.score);
  },
}));

const {
  bibleAnchor,
  anchorConfidenceHigh,
  sequenceByBibleAnchor,
  orderResolvedResults,
  idxFromItemId,
  chapterItemId,
} = await import("../src/services/bible-anchor.js");

const ENV = { EMERGENTDB_API_KEY: "k" } as never;

test("bibleAnchor returns {idx, ref, sim} from substrate metadata", async () => {
  const a = await bibleAnchor(ENV, "in the beginning God created");
  expect(a).not.toBeNull();
  expect(a!.idx).toBe(0);
  expect(a!.ref).toBe("Genesis 1");
  expect(a!.sim).toBeCloseTo(0.82, 2);
});

test("bibleAnchor fails closed (null) on no match or empty text", async () => {
  expect(await bibleAnchor(ENV, "")).toBeNull();
  expect(await bibleAnchor(ENV, "zzz no anchor here")).toBeNull();
});

test("chapterItemId / idxFromItemId round-trip", () => {
  expect(chapterItemId(0)).toBe("ch-0000");
  expect(chapterItemId(1188)).toBe("ch-1188");
  expect(idxFromItemId("ch-0042")).toBe(42);
  expect(idxFromItemId("not-a-chapter")).toBeNull();
});

test("apophenia gate: high only when top strong AND separated", () => {
  expect(anchorConfidenceHigh([0.82, 0.40, 0.41])).toBe(true);   // top .82, gap vs mid .41 = .41
  expect(anchorConfidenceHigh([0.62, 0.61, 0.60])).toBe(false);  // strong top but no separation
  expect(anchorConfidenceHigh([0.55, 0.20])).toBe(false);        // top below floor
  expect(anchorConfidenceHigh([0.9])).toBe(false);               // need >= 2
});

test("sequenceByBibleAnchor reorders by canonical idx on HIGH confidence, set preserved", async () => {
  // One strong, separated anchor (create .82) vs two weak (shepherd .40, tax .41):
  // sorted sims [.40,.41,.82], median .41, gap .41 >= .15, top >= .6 -> HIGH.
  // Input is in non-canonical (relevance) order to prove the reorder is real.
  const input = ["pay the tax", "create a project", "shepherd of the flock"];
  const r = await sequenceByBibleAnchor(ENV, input, (s) => s);
  expect(r.applied).toBe(true);
  expect(r.confidence).toBe("high");
  // canonical order: create(idx0) < shepherd(500) < tax(700)
  expect(r.items).toEqual(["create a project", "shepherd of the flock", "pay the tax"]);
  // SET preserved — same elements, only order changed
  expect([...r.items].sort()).toEqual([...input].sort());
});

test("sequenceByBibleAnchor preserves input order on LOW confidence", async () => {
  // all weak anchors (shepherd .40, tax .41) -> low confidence, untouched
  const input = ["shepherd of the flock", "pay the tax"];
  const r = await sequenceByBibleAnchor(ENV, input, (s) => s);
  expect(r.applied).toBe(false);
  expect(r.confidence).toBe("low");
  expect(r.items).toEqual(input); // verbatim relevance order
});

test("orderResolvedResults sequences both lists by anchor, set + non-list fields preserved", async () => {
  const resolved = {
    domain_results: [
      { id: "s1:e1", metadata: { title: "pay the tax for me" } },       // tax 700
      { id: "s2:e2", metadata: { title: "create a new project" } },     // create 0
      { id: "s3:e3", metadata: { title: "shepherd of the flock" } },    // shepherd 500
    ],
    global_results: [],
    skipped_global: false,
  };
  const out = await orderResolvedResults(ENV, resolved);
  // high confidence (create .82 separated) -> canonical order create<shepherd<tax
  expect(out.domain_results.map((r) => r.id)).toEqual(["s2:e2", "s3:e3", "s1:e1"]);
  // SET preserved (same ids), non-list field untouched
  expect(out.domain_results.map((r) => r.id).sort()).toEqual(["s1:e1", "s2:e2", "s3:e3"]);
  expect(out.skipped_global).toBe(false);
  expect(out.global_results).toEqual([]);
});
