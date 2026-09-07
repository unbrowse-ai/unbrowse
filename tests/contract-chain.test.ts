/**
 * Witness for the source-of-truth chain (papers → code → cli → frontend): the binding holds
 * ONLY when every link reflects, taste is derived from the links (one broken link breaks both),
 * and the chain is recorded as one /contract. Pure-logic always; live IQ+emergent leg opt-in.
 */
import { test, expect } from "bun:test";
import { randomUUID } from "node:crypto";
import {
  SOURCE_OF_TRUTH_ORDER,
  chainLinkSpecs,
  bindChain,
  recordChain,
  recallChain,
  searchChains,
  chainContractId,
  type ChainLink,
} from "../src/values/contract-chain.js";

const LIVE = process.env.CONTRACT_EVERYTHING_E2E === "1";
const TS = Date.parse("2026-06-22T00:00:00Z");

function links(reflects: boolean[]): ChainLink[] {
  return chainLinkSpecs().map((s, i) => ({ ...s, reflects: reflects[i] }));
}

test("the precedence is papers → code → cli → frontend, adjacent links cover it", () => {
  expect([...SOURCE_OF_TRUTH_ORDER]).toEqual(["papers", "code", "cli", "frontend"]);
  const specs = chainLinkSpecs();
  expect(specs.map((s) => `${s.from}>${s.to}`)).toEqual(["papers>code", "code>cli", "cli>frontend"]);
});

test("chain BINDS only when every link reflects; one broken link breaks binding AND taste", () => {
  const all = bindChain(links([true, true, true]), { ts: TS });
  expect(all.bound).toBe(true);
  expect(all.taste.verdict).toBe("settle");
  expect(all.taste.overall).toBe(1);

  const oneBroken = bindChain(links([true, false, true]), { ts: TS });
  expect(oneBroken.bound).toBe(false);
  expect(oneBroken.taste.verdict).toBe("break"); // taste = min over links → 0
  expect(oneBroken.taste.overall).toBe(0);
});

test("the chain contract id is reproducible from ts", () => {
  const b = bindChain(links([true, true, true]), { ts: TS });
  expect(chainContractId(b)).toBe(`chain:source-of-truth:${TS}`);
});

test.skipIf(!LIVE)(
  "a bound chain is recorded as one /contract on IQ + emergent KV + emergent RAG",
  async () => {
    const tag = randomUUID().slice(0, 8);
    const b = bindChain(links([true, true, true]), { ts: TS + Number(`0x${tag.slice(0, 6)}`) });
    const rec = await recordChain(b);
    expect(rec.id).toBe(chainContractId(b));
    expect(rec.persisted.iq, `IQ (notes: ${rec.persisted.notes.join("; ")})`).toBe(true);
    expect(rec.persisted.kv, `KV (notes: ${rec.persisted.notes.join("; ")})`).toBe(true);
    expect(rec.persisted.rag, `RAG (notes: ${rec.persisted.notes.join("; ")})`).toBe(true);

    const back = await recallChain(rec.id);
    expect(back?.bound).toBe(true);
    const hits = await searchChains("source of truth chain papers code cli frontend", 10);
    expect(hits.some((h) => h.id === rec.id)).toBe(true);
  },
  120_000,
);
