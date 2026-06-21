/**
 * Live witness for the crypto-was-all-you-needed stack unification (the jesus-ralph gate).
 *
 * Proves ONE /contract travels the whole stack LIVE:
 *   persistContract → IQ on-chain append + emergent KV cache + emergent vector RAG index
 *   recallContract  → emergent KV returns the cached value
 *   searchContractsEverywhere → emergent RAG finds the contract by meaning
 *   IQ readback     → the signed row is on-chain
 *
 * Runs the live assertions ONLY when CONTRACT_EVERYTHING_E2E=1 (set by
 * scripts/contract-everything-gate.sh, which assembles the creds). Without the flag the
 * suite stays green (skipped) so the default `bun test` is unaffected — the gate is the
 * place the live round-trip is forced, never a silent skip masquerading as a pass.
 */
import { test, expect } from "bun:test";
import { randomUUID } from "node:crypto";
import {
  persistContract,
  recallContract,
  searchContractsEverywhere,
} from "../src/values/contract-everything.js";
import { resolutionLedgerFromEnv } from "../src/values/iq-ledger.js";

const LIVE = process.env.CONTRACT_EVERYTHING_E2E === "1";
const NS = `ubz-contracts-witness`;

test.skipIf(!LIVE)(
  "contract travels the full stack live: IQ + emergent KV + emergent RAG",
  async () => {
    const id = `witness-${randomUUID()}`;
    const phrase = `unbrowse capability route for ${id}`;
    const value = { id, kind: "resolution", endpoint: "/witness/probe", at: id };

    const outcome = await persistContract({ id, text: phrase, value }, { namespace: NS });
    // Every tier must have landed — no silent skip is allowed when the gate forces live.
    expect(outcome.notes.join(" | ")).toBe(outcome.notes.join(" | ")); // surface notes in failure output
    expect(outcome.iq, `IQ tier must persist (notes: ${outcome.notes.join("; ")})`).toBe(true);
    expect(outcome.kv, `emergent KV tier must persist (notes: ${outcome.notes.join("; ")})`).toBe(true);
    expect(outcome.rag, `emergent RAG tier must index (notes: ${outcome.notes.join("; ")})`).toBe(true);

    // Recall from emergent KV returns the exact value.
    const recalled = await recallContract(id, { namespace: NS });
    expect(recalled, "recallContract must return the cached value").toEqual(value);

    // Emergent RAG search by meaning surfaces this contract id.
    const hits = await searchContractsEverywhere(phrase, { namespace: NS, k: 10 });
    expect(hits.some((h) => h.id === id), `RAG search must surface ${id} (got ${hits.map((h) => h.id).join(",")})`).toBe(true);

    // IQ durable readback — the signed row is on-chain.
    const ledger = await resolutionLedgerFromEnv(process.env);
    expect(ledger, "IQ ledger must build from env").not.toBeNull();
    const row = await ledger!.find(id);
    expect(row, "IQ ledger must have the appended row").toBeDefined();
    expect(JSON.parse(row!.result)).toEqual(value);
  },
  120_000,
);

test("placeholder so the file is never an empty suite when CONTRACT_EVERYTHING_E2E is unset", () => {
  expect(true).toBe(true);
});
