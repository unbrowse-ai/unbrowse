/**
 * Witness for mechanical cross-contract reconciliation: claims in one prompt are extracted,
 * paired, and judged agree/contradict/unrelated by string logic (no LLM). The set settles iff
 * no pair contradicts. Pure-logic always; the live record leg is opt-in.
 */
import { test, expect } from "bun:test";
import { randomUUID } from "node:crypto";
import {
  extractContractClaims,
  reconcile,
  recordReconciliation,
  recallReconciliation,
  searchReconciliations,
  reconcileContractId,
} from "../src/values/contract-reconcile.js";

const LIVE = process.env.CONTRACT_EVERYTHING_E2E === "1";
const TS = Date.parse("2026-06-22T00:00:00Z");

test("extract pulls each /contract claim (and aliases) out of one prompt", () => {
  const claims = extractContractClaims("/contract bind the chain /contract-deploy ship it /taste judge");
  expect(claims).toEqual(["bind the chain", "ship it /taste judge"]);
});

test("a related pair with asymmetric negation CONTRADICTS → the set breaks", () => {
  const v = reconcile(["the chain is bound to one source of truth", "the chain is not bound to one source of truth"], { ts: TS });
  expect(v.pairs[0].verdict).toBe("contradict");
  expect(v.pairs[0].conflictingTokens).toContain("bound");
  expect(v.verdict).toBe("break");
  expect(v.contradictions).toBe(1);
});

test("related claims with the SAME polarity agree; unrelated claims never contradict → settle", () => {
  const agree = reconcile([
    "use the residential proxy by default for egress",
    "use the residential proxy by default everywhere",
  ], { ts: TS });
  expect(agree.pairs[0].verdict).toBe("agree");
  expect(agree.verdict).toBe("settle");

  const unrelated = reconcile([
    "papers are the truth root of the stack",
    "the espresso machine needs descaling",
  ], { ts: TS });
  expect(unrelated.pairs[0].verdict).toBe("unrelated");
  expect(unrelated.verdict).toBe("settle");
});

test("one contradiction anywhere breaks the whole set (min over pairs)", () => {
  const v = reconcile([
    "enable the proxy by default",
    "papers reflect code",
    "never enable the proxy by default",
  ], { ts: TS });
  expect(v.verdict).toBe("break");
  expect(v.contradictions).toBe(1);
  expect(reconcileContractId(v)).toBe(`reconcile:3:${TS}`);
});

test.skipIf(!LIVE)(
  "a reconciliation verdict is recorded as a /contract on IQ + emergent KV + emergent RAG",
  async () => {
    const tag = randomUUID().slice(0, 8);
    const v = reconcile([`bind ${tag} now`, `do not bind ${tag} now`], { ts: TS + Number(`0x${tag.slice(0, 6)}`) });
    const rec = await recordReconciliation(v);
    expect(rec.id).toBe(reconcileContractId(v));
    expect(rec.persisted.iq, `IQ (notes: ${rec.persisted.notes.join("; ")})`).toBe(true);
    expect(rec.persisted.kv, `KV (notes: ${rec.persisted.notes.join("; ")})`).toBe(true);
    expect(rec.persisted.rag, `RAG (notes: ${rec.persisted.notes.join("; ")})`).toBe(true);
    const back = await recallReconciliation(rec.id);
    expect(back?.verdict).toBe("break");
    const hits = await searchReconciliations("reconcile contradicting contracts", 10);
    expect(hits.some((h) => h.id === rec.id)).toBe(true);
  },
  120_000,
);
