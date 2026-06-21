/**
 * Witness for crypto-was-all-you-needed Phase 5 — emergent-graph search over the contract
 * ledger: index a fixture ledger → query by MEANING → the relevant contract ranks first.
 * Deterministic: real cosine math over a feature-hashing embedder + in-memory store (no
 * network). The OpenAI/EmergentDB live legs are opt-in (EMBED_E2E=1) and gated on a FUNDED
 * key — default-skipped so the suite never depends on quota or an external service.
 */
import { test, expect } from "bun:test";
import {
  indexContractRows, searchContracts, hashEmbedder, memCosineStore, openAiEmbedder, cosine,
  type ContractRow,
} from "../src/values/contract-search.js";

// A small fixture "ledger" of contracts, each a distinct topic.
const LEDGER: ContractRow[] = [
  { id: "c1", text: "render a sealed value only upon authentication of the wallet bound to it" },
  { id: "c2", text: "cold hydrate the local resolution ledger from the on-chain signed history" },
  { id: "c3", text: "mirror every resolution to the IQ on-chain ledger fire and forget" },
  { id: "c4", text: "the frontend connects a wallet then reveals the contract value" },
];

test("index fixture ledger → semantic query ranks the relevant contract first (real cosine)", async () => {
  const embed = hashEmbedder();
  const store = memCosineStore();

  const n = await indexContractRows(LEDGER, embed, store);
  expect(n).toBe(4);
  expect(store.size()).toBe(4);

  // A query about wallet-gated reveal must rank c1 first by meaning (shared tokens), not order.
  const hits = await searchContracts("reveal a value only when the bound wallet authenticates", embed, store, 4);
  expect(hits[0].id).toBe("c1");
  // A query about hydration must rank c2 first.
  const hits2 = await searchContracts("clone the signed history into the local cache on a cold machine", embed, store, 4);
  expect(hits2[0].id).toBe("c2");
});

test("cosine is a real similarity: identical > related > unrelated", () => {
  const e = hashEmbedder();
  const same = cosine([1, 0, 2], [1, 0, 2]);
  expect(same).toBeCloseTo(1, 5);
  expect(cosine([1, 0, 0], [0, 1, 0])).toBe(0); // orthogonal → no similarity
});

test("openAiEmbedder is null without a key (offline falls back to hashEmbedder)", () => {
  expect(openAiEmbedder({})).toBeNull();
  expect(openAiEmbedder({ OPENAI_API_KEY: "sk-x" })).not.toBeNull();
});

// ── Live leg (opt-in, FUNDED key required) — proves the real OpenAI embedding integration.
const liveEmbed = process.env.EMBED_E2E === "1";
test.skipIf(!liveEmbed)("LIVE: OpenAI embeddings rank the relevant contract first (1536-dim)", async () => {
  const embed = openAiEmbedder();
  if (!embed) throw new Error("OPENAI_API_KEY required for EMBED_E2E");
  const store = memCosineStore();
  await indexContractRows(LEDGER, embed, store);
  const hits = await searchContracts("how do I show a value only to the wallet it belongs to", embed, store, 4);
  expect(hits[0].id).toBe("c1");
});
