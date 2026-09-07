/**
 * Convergence conformance — the single Zig WASM core's `fuse_score` is
 * bit-for-bit identical to the pure-TS `energyScoreTs` across the same vectors
 * (incl. NaN / missing-dense / +-Infinity edges) the unbrowse-core conformance
 * witness uses. This is the witness that the Zig-core energy-ordering rewire
 * (resolve energy served by the WASM, TS as fallback) preserves the live
 * ranking: identical energy/witnesses/agree -> nothing re-orders.
 *
 * EPSILON: 0 (bit-identical). Both legs compute the SAME IEEE-754 f64 ops in the
 * SAME order; the WASM emits shortest-round-trippable f64 text that bun parses
 * back to the identical f64. We assert exact equality on energy, both witnesses,
 * and agree.
 *
 * Run: bun test tests/core-wasm-energy-conformance.test.ts   (from backend/)
 */
import { describe, expect, test } from "bun:test";
import { energyScoreViaWasm } from "../src/services/core-wasm";
import { energyScoreTs } from "../src/services/energy";

// dense encoding parity with unbrowse-core/test/energy-conformance.test.ts:
// real numbers pass as numbers; the three IEEE specials pass as JS Infinity/NaN
// (energyScoreViaWasm maps them to the WASM string sentinels); `undefined` field
// => omit `dense` entirely (== TS evidence.dense absent).
type DenseSpec = number | "NaN" | "Infinity" | "-Infinity" | undefined;

function evidenceOf(d: DenseSpec): { dense: number } | undefined {
  if (d === undefined) return undefined;
  if (d === "NaN") return { dense: NaN };
  if (d === "Infinity") return { dense: Infinity };
  if (d === "-Infinity") return { dense: -Infinity };
  return { dense: d };
}

// (intent, candidate text, dense) vectors — ported verbatim from unbrowse-core's
// energy-conformance.test.ts, including the NaN/missing/Infinity edge battery.
const vectors: Array<[string, string, DenseSpec]> = [
  // ordinary fusion
  ["list my recent orders", "orders list recent order history", 0.9],
  ["list my recent orders", "weather forecast unrelated payload", 0.1],
  ["list my recent orders", "list recent orders order history mine", 0.5],
  ["list my recent orders", "graphql endpoint node payload", 0.95],
  ["list my recent orders", "graphql endpoint node payload", 0.05],
  ["list my recent orders", "list recent orders order history mine", 0.95],
  ["list my recent orders", "list recent orders order history mine", 0.05],
  ["list my recent orders", "list recent orders order history", 0.9],
  ["list my recent orders", "list recent orders order history", 0.02],
  // agreement boundary (dense exactly 0.5, lex around threshold)
  ["list my recent orders", "list recent orders order history", 0.5],
  ["get all the products now", "Products Catalog LISTING page", 0.5],
  // empty intent => lex witness 0, dense controls
  ["", "list recent orders order history", 0.7],
  // zero shared tokens => energy == -dense
  ["list my recent orders", "zzz qqq vvv unrelated payload graphql", 0.9],
  ["list my recent orders", "zzz qqq vvv unrelated payload graphql", 0.1],
  // mixed case / punctuation tokenization parity
  ["List My Recent Orders!!!", "ORDERS, recent: order-history (mine)", 0.42],
  // long inputs (bounded)
  ["orders ".repeat(1500).trim(), "list recent orders order ".repeat(420).trim(), 0.5],
  // --- NaN-guard / missing-dense edge battery ---
  ["list my recent orders", "list recent orders order history", undefined], // absent dense
  ["list my recent orders", "list recent orders order history", "NaN"],
  ["list my recent orders", "list recent orders order history", "Infinity"],
  ["list my recent orders", "list recent orders order history", "-Infinity"],
  ["", "zzz qqq vvv", "NaN"], // empty intent AND NaN dense
  ["", "zzz qqq vvv", undefined], // empty intent AND absent dense
];

describe("Zig WASM fuse_score === TS energyScoreTs (bit-identical, incl. NaN/missing edges)", () => {
  for (const [intent, text, d] of vectors) {
    const label = `intent=${JSON.stringify(intent.slice(0, 40))} text=${JSON.stringify(text.slice(0, 40))} dense=${String(d)}`;
    test(label, () => {
      const ev = evidenceOf(d);
      const ts = energyScoreTs(intent, { id: 0, text }, ev as { dense: number });
      const zig = energyScoreViaWasm(intent, { id: 0, text }, ev);

      // The WASM must load in bun:test — null here is a real regression.
      expect(zig).not.toBeNull();
      const w = zig!;

      // Bit-identical energy + witnesses + agree.
      expect(w.energy, `energy mismatch @ ${label}`).toBe(ts.energy);
      expect(w.witnesses[0], `lex witness mismatch @ ${label}`).toBe(ts.witnesses[0]);
      expect(w.witnesses[1], `dense witness mismatch @ ${label}`).toBe(ts.witnesses[1]);
      expect(w.agree, `agree mismatch @ ${label}`).toBe(ts.agree);

      // The NaN-guard contract: never a NaN/non-finite energy out, either leg.
      expect(Number.isFinite(w.energy), `non-finite Zig energy @ ${label}`).toBe(true);
      expect(Number.isFinite(ts.energy), `non-finite TS energy @ ${label}`).toBe(true);
    });
  }

  test("missing dense and explicit-NaN dense produce the IDENTICAL energy (NaN-guard parity)", () => {
    const intent = "list my recent orders";
    const text = "list recent orders order history";
    const missing = energyScoreViaWasm(intent, { id: 0, text }, undefined);
    const nan = energyScoreViaWasm(intent, { id: 0, text }, { dense: NaN });
    expect(missing).not.toBeNull();
    expect(nan).not.toBeNull();
    expect(missing!.energy).toBe(nan!.energy);
    expect(missing!.witnesses[1]).toBe(0); // dense defaulted to 0, not NaN
    expect(nan!.witnesses[1]).toBe(0);
    // And both match TS.
    const tsMissing = energyScoreTs(intent, { id: 0, text }, {} as { dense: number });
    expect(missing!.energy).toBe(tsMissing.energy);
  });
});
