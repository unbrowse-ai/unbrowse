/**
 * semantic-cache-exact-witness — proves the L1 exact-match fast path against LIVE
 * EmergentDB + Nebius. A verbatim-repeated query must resolve via ONE qdkv/get
 * (~0.8s), NOT the L2 embed (~2s) + vector-search (~1.2s) path.
 *
 * Exit 0 iff: a second, identical query returns cached AND in less time than a
 * single embed call takes (so it provably did NOT go through L2).
 *
 *   EMERGENTDB_API_KEY=... NEBIUS_API_KEY=... bun semantic-cache-exact-witness.ts
 */
import fs from "node:fs";
import path from "node:path";
import { getOrComputeSemantic, clearSemanticL0 } from "../src/services/semantic-cache.js";

for (const p of [path.join(process.cwd(), ".env"), path.join(process.cwd(), "..", ".env")]) {
  if (!fs.existsSync(p)) continue;
  for (const line of fs.readFileSync(p, "utf8").split("\n")) {
    const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, "");
  }
}
const env = {
  EMERGENTDB_API_KEY: process.env.EMERGENTDB_API_KEY,
  NEBIUS_API_KEY: process.env.NEBIUS_API_KEY,
  SEMANTIC_CACHE_NAMESPACE: "unbrowse-exact-witness",
  // Disable the L2 fuzzy tier (threshold > 1) so the first call is a GUARANTEED
  // miss — otherwise a semantically-similar query from a PRIOR run could L2-hit
  // and the first call wouldn't write the L1 key we want to test. This witness
  // isolates the L1 (qdkv exact) path specifically.
  SEMANTIC_CACHE_THRESHOLD: "1.01",
};
if (!env.EMERGENTDB_API_KEY || !env.NEBIUS_API_KEY) {
  console.error("[witness] missing keys"); process.exit(2);
}

// Genuinely UNIQUE query → guaranteed fresh L1 miss on the first call (a repeated
// random-word combo could collide on the exact hash across runs).
const q = `exact-path-${Math.random().toString(36).slice(2)}-${Date.now()}`;

// Time one bare embed call as the L2 floor — an L1 hit must beat this.
const tEmb = Date.now();
await fetch("https://api.tokenfactory.nebius.com/v1/embeddings", {
  method: "POST",
  headers: { Authorization: `Bearer ${env.NEBIUS_API_KEY}`, "Content-Type": "application/json" },
  body: JSON.stringify({ model: "Qwen/Qwen3-Embedding-8B", input: q, dimensions: 1536 }),
}).then((r) => r.text());
const embedMs = Date.now() - tEmb;

// 1st call: MISS → computes + schedules the deferred write (incl. the L1 exact key).
const writes: Promise<unknown>[] = [];
const first = await getOrComputeSemantic(env, "x", q, async () => "EXACT-VALUE", (p) => writes.push(p));
await Promise.all(writes); // let the deferred write-through (incl. L1) finish

// Clear the in-process L0 so this verbatim repeat genuinely exercises L1 (the qdkv
// exact path) rather than the 0ms in-memory tier that would otherwise shadow it.
clearSemanticL0();
// 2nd call: identical query → must hit L1 (one qdkv/get), fast, no embed.
const t2 = Date.now();
const second = await getOrComputeSemantic(env, "x", q, async () => "SHOULD-NOT-COMPUTE");
const l1Ms = Date.now() - t2;

const pass = first.cached === false && second.cached === true && second.value === "EXACT-VALUE" && l1Ms < embedMs;
console.log(`[witness] embed-floor=${embedMs}ms   L1-exact-hit=${l1Ms}ms   1st.cached=${first.cached} 2nd.cached=${second.cached}`);
console.log(`[witness] ${pass
  ? `PASS — exact repeat hit L1 in ${l1Ms}ms (< a single ${embedMs}ms embed), so it skipped the L2 embed+vector path`
  : "FAIL — exact repeat did not take the fast L1 path"}`);
process.exit(pass ? 0 : 1);
