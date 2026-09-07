/**
 * Witness for /taste as a /contract: judgeTaste settles only when every axis clears the bar
 * (min, not mean), produces a reproducible id, and records onto the full stack. Pure-logic
 * assertions run always; the live IQ+emergent leg is opt-in (CONTRACT_EVERYTHING_E2E=1).
 */
import { test, expect } from "bun:test";
import { randomUUID } from "node:crypto";
import {
  judgeTaste,
  recordTaste,
  recallTaste,
  searchTaste,
  tasteContractId,
} from "../src/values/contract-taste.js";

const LIVE = process.env.CONTRACT_EVERYTHING_E2E === "1";
const TS = Date.parse("2026-06-22T00:00:00Z");

test("taste settles only when EVERY axis clears the threshold (weakest link caps it)", () => {
  const good = judgeTaste("landing", [
    { name: "vitals", score: 0.9 },
    { name: "visual", score: 0.8 },
    { name: "a11y", score: 0.75 },
  ], { ts: TS });
  expect(good.overall).toBeCloseTo(0.75, 5); // the MIN, not the mean
  expect(good.verdict).toBe("settle");

  const broken = judgeTaste("landing", [
    { name: "vitals", score: 0.99 },
    { name: "visual", score: 0.95 },
    { name: "a11y", score: 0.4 }, // one broken axis
  ], { ts: TS });
  expect(broken.overall).toBeCloseTo(0.4, 5);
  expect(broken.verdict).toBe("break"); // a beautiful page with broken a11y has no taste
});

test("scores clamp to 0..1 and the id is reproducible from (subject, ts)", () => {
  const v = judgeTaste("Deploy X!", [{ name: "a", score: 1.5 }, { name: "b", score: -0.2 }], { ts: TS });
  expect(v.dimensions[0].score).toBe(1);
  expect(v.dimensions[1].score).toBe(0);
  expect(tasteContractId(v)).toBe(`taste:deploy-x:${TS}`);
  expect(tasteContractId(judgeTaste("Deploy X!", [], { ts: TS }))).toBe(tasteContractId(v));
});

test.skipIf(!LIVE)(
  "a taste verdict is recorded as a /contract on IQ + emergent KV + emergent RAG",
  async () => {
    const tag = randomUUID().slice(0, 8);
    const v = judgeTaste(`witness-${tag}`, [
      { name: "vitals", score: 0.9 },
      { name: "visual", score: 0.85 },
    ], { ts: TS + Number(`0x${tag.slice(0, 6)}`) });

    const rec = await recordTaste(v);
    expect(rec.id).toBe(tasteContractId(v));
    expect(rec.persisted.iq, `IQ (notes: ${rec.persisted.notes.join("; ")})`).toBe(true);
    expect(rec.persisted.kv, `KV (notes: ${rec.persisted.notes.join("; ")})`).toBe(true);
    expect(rec.persisted.rag, `RAG (notes: ${rec.persisted.notes.join("; ")})`).toBe(true);

    const back = await recallTaste(rec.id);
    expect(back?.verdict).toBe("settle");
    const hits = await searchTaste(`taste verdict ${v.subject}`, 10);
    expect(hits.some((h) => h.id === rec.id)).toBe(true);
  },
  120_000,
);
