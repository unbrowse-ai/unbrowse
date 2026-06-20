import { test, expect } from "bun:test";
// RED-FIRST SEED: this module does NOT exist yet. The import (or the call) fails on
// purpose — it pins the DESIGN CONTRACT for a unified "energy" ranking interface that
// unifies the two ranking witnesses already in the tree:
//   - the lexical witness (rank-bm25.ts bm25Score / rank.ts url_path_overlap)
//   - the dense/structural witness (discovery.ts rrfFuse over the dense vector list,
//     rank.ts schema/host/reliability signals)
// Today those fuse by a FIXED reciprocal-rank vote (discovery.ts rrfFuse, RRF_K=60).
// `energy` replaces that fixed vote with an EVIDENCE-ROUTED fusion and an energy (= -score)
// convention so a better match has LOWER energy (EBM direction).
//
// Contract under test (will fail until backend/src/services/energy.ts ships energyScore):
import { energyScore } from "../src/services/energy";

// Small inline candidate objects: {id, text} mirrors the SearchResult identity
// (discovery.ts: SearchResult = Array<{id; score; metadata}>) reduced to what the
// ranker actually reads — an id + the candidate's own text the lexical witness scores.
type Candidate = { id: number; text: string };

// Evidence = the per-witness signals the existing rankers already derive. We hand the
// dense/structural witness in directly (as discovery's dense vector list does) so the
// test does not depend on an embedding model: `dense` is the structural-similarity
// witness score in [0,1] (higher = better match), like reliability/schema/host signals
// in rank.ts surface as a structural delta.
type Evidence = { dense: number };

// --- Contract 1: energy === -score direction (better match => LOWER energy) ---
test("CONTRACT 1: a better-matching candidate has LOWER energy than a worse one", () => {
  const intent = "list my recent orders";
  const good: Candidate = { id: 1, text: "orders list recent order history" };
  const bad: Candidate = { id: 2, text: "weather forecast unrelated payload" };
  // Both witnesses agree the good candidate matches: strong lexical overlap AND high dense.
  const goodE = energyScore(intent, good, { dense: 0.9 });
  const badE = energyScore(intent, bad, { dense: 0.1 });

  expect(typeof goodE.energy).toBe("number");
  // energy = -score: the better match settles to a LOWER energy.
  expect(goodE.energy).toBeLessThan(badE.energy);
});

// --- Contract 2: evidence-routed fusion (NOT a fixed RRF vote) ---
test("CONTRACT 2: weak lexical evidence down-weights the lexical witness vs a strong-lexical case", () => {
  const intent = "list my recent orders";

  // WEAK-LEXICAL: candidate text shares NO tokens with the intent, but the dense
  // (structural) witness is strong. A fixed RRF vote would treat both witnesses with
  // equal weight; evidence-routed fusion must lean on the dense witness here.
  const weakLex: Candidate = { id: 10, text: "graphql endpoint node payload" };
  const weakLexHighDense = energyScore(intent, weakLex, { dense: 0.95 });
  const weakLexLowDense = energyScore(intent, weakLex, { dense: 0.05 });

  // STRONG-LEXICAL: candidate text shares the intent's tokens. Here the lexical witness
  // carries real weight, so flipping the dense witness should move energy LESS than it
  // did in the weak-lexical case (the two cases must fuse DIFFERENTLY).
  const strongLex: Candidate = { id: 11, text: "list recent orders order history mine" };
  const strongLexHighDense = energyScore(intent, strongLex, { dense: 0.95 });
  const strongLexLowDense = energyScore(intent, strongLex, { dense: 0.05 });

  const denseSwingWhenLexWeak = Math.abs(weakLexHighDense.energy - weakLexLowDense.energy);
  const denseSwingWhenLexStrong = Math.abs(strongLexHighDense.energy - strongLexLowDense.energy);

  // Evidence-routed: when lexical evidence is weak, the ORDERING relies MORE on the
  // dense witness, so swinging dense moves energy MORE than when lexical is strong.
  // (A fixed RRF vote would make these two swings equal — that is the design this rejects.)
  expect(denseSwingWhenLexWeak).toBeGreaterThan(denseSwingWhenLexStrong);
});

// --- Contract 3: two witnesses + agreement flag ---
test("CONTRACT 3: witnesses has length 2 and agree is a boolean reflecting concurrence", () => {
  const intent = "list my recent orders";

  // Both witnesses concur (strong lexical AND strong dense) => agree = true.
  const concur = energyScore(intent, { id: 20, text: "list recent orders order history" }, { dense: 0.9 });
  expect(Array.isArray(concur.witnesses)).toBe(true);
  expect(concur.witnesses).toHaveLength(2);
  expect(concur.witnesses.every((w) => typeof w === "number")).toBe(true);
  expect(typeof concur.agree).toBe("boolean");
  expect(concur.agree).toBe(true);

  // Witnesses disagree: strong lexical but the dense witness says no-match => agree = false.
  const conflict = energyScore(intent, { id: 21, text: "list recent orders order history" }, { dense: 0.02 });
  expect(conflict.agree).toBe(false);
});

// --- EDGE 1: empty intent string => finite energy, no throw ---
test("EDGE 1: empty intent string returns finite energy and does not throw", () => {
  let res: ReturnType<typeof energyScore>;
  expect(() => {
    res = energyScore("", { id: 30, text: "list recent orders order history" }, { dense: 0.7 });
  }).not.toThrow();
  expect(Number.isFinite(res!.energy)).toBe(true);
  // With no intent tokens the lexical witness is 0 and the dense witness controls.
  expect(res!.witnesses[0]).toBe(0);
  expect(Number.isFinite(res!.witnesses[1])).toBe(true);
});

// --- EDGE 2: zero shared tokens (lex_conf ~ 0) => dense witness dominates, no NaN ---
test("EDGE 2: zero shared tokens lets the dense witness dominate with no NaN", () => {
  const intent = "list my recent orders";
  // Candidate shares NO content tokens with the intent.
  const noShare: Candidate = { id: 31, text: "zzz qqq vvv unrelated payload graphql" };
  const hi = energyScore(intent, noShare, { dense: 0.9 });
  const lo = energyScore(intent, noShare, { dense: 0.1 });

  expect(hi.witnesses[0]).toBe(0); // lexical witness is exactly 0 (no overlap)
  expect(Number.isFinite(hi.energy)).toBe(true);
  expect(Number.isNaN(hi.energy)).toBe(false);
  // Dense fully controls the ordering: energy = -dense, so higher dense => lower energy.
  expect(hi.energy).toBeLessThan(lo.energy);
  expect(hi.energy).toBeCloseTo(-0.9, 10);
});

// --- EDGE 3: identical candidates => equal energy, consistent agreement ---
test("EDGE 3: identical candidates score identically and agree consistently", () => {
  const intent = "list my recent orders";
  const a: Candidate = { id: 40, text: "list recent orders order history mine" };
  const b: Candidate = { id: 41, text: "list recent orders order history mine" };
  const ea = energyScore(intent, a, { dense: 0.8 });
  const eb = energyScore(intent, b, { dense: 0.8 });

  expect(ea.energy).toBe(eb.energy);
  expect(ea.witnesses[0]).toBe(eb.witnesses[0]);
  expect(ea.witnesses[1]).toBe(eb.witnesses[1]);
  expect(ea.agree).toBe(eb.agree);
});

// --- EDGE 4: adversarial extremely long intent / candidate (10k chars) => bounded, finite, no throw ---
test("EDGE 4: extremely long intent and candidate stay bounded and finite", () => {
  const longIntent = "orders ".repeat(1500).trim(); // ~10.5k chars
  const longText = "list recent orders order ".repeat(420).trim(); // ~10.5k chars
  expect(longIntent.length).toBeGreaterThan(10000);
  expect(longText.length).toBeGreaterThan(10000);

  let res: ReturnType<typeof energyScore>;
  expect(() => {
    res = energyScore(longIntent, { id: 50, text: longText }, { dense: 0.5 });
  }).not.toThrow();
  expect(Number.isFinite(res!.energy)).toBe(true);
  // score is a [0,1] blend => energy in [-1, 0].
  expect(res!.energy).toBeLessThanOrEqual(0);
  expect(res!.energy).toBeGreaterThanOrEqual(-1);
  expect(res!.witnesses[0]).toBeGreaterThanOrEqual(0);
  expect(res!.witnesses[0]).toBeLessThanOrEqual(1);
});

// --- EDGE 5: evidence with missing/undefined structural fields => graceful default, no NaN/Infinity ---
test("EDGE 5: missing/undefined dense evidence defaults gracefully with no NaN/Infinity", () => {
  const intent = "list my recent orders";
  const cand: Candidate = { id: 60, text: "list recent orders order history" };

  // dense is undefined (field absent on the evidence object).
  const missing = energyScore(intent, cand, {} as Evidence);
  expect(Number.isFinite(missing.energy)).toBe(true);
  expect(Number.isNaN(missing.energy)).toBe(false);
  expect(missing.witnesses.every((w) => Number.isFinite(w))).toBe(true);
  expect(typeof missing.agree).toBe("boolean");

  // dense is explicitly NaN.
  const nanDense = energyScore(intent, cand, { dense: NaN });
  expect(Number.isFinite(nanDense.energy)).toBe(true);

  // dense is +/-Infinity => must clamp into [0,1], not blow up.
  const posInf = energyScore(intent, cand, { dense: Infinity });
  const negInf = energyScore(intent, cand, { dense: -Infinity });
  expect(Number.isFinite(posInf.energy)).toBe(true);
  expect(Number.isFinite(negInf.energy)).toBe(true);
  expect(posInf.witnesses[1]).toBe(1); // clamped up
  expect(negInf.witnesses[1]).toBe(0); // clamped down
});
