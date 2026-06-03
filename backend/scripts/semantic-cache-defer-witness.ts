/**
 * semantic-cache-defer-witness — proves the cache write-through is DEFERRED, not
 * awaited inline, against the LIVE EmergentDB + Nebius services.
 *
 * Why it matters: EmergentDB writes are ~5s (vectors/insert + search + qdkv/set).
 * If the write-through were awaited inline, every cache MISS would return ~5s
 * SLOWER than the bare compute — a cache that makes things slower. With deferral
 * (ctx.waitUntil), the response returns the instant compute resolves and the cache
 * populates in the background.
 *
 * Exit 0 iff: a miss returns BEFORE its scheduled write-through finishes (i.e. the
 * write took real time AFTER getOrComputeSemantic already returned).
 *
 *   EMERGENTDB_API_KEY=... NEBIUS_API_KEY=... bun semantic-cache-defer-witness.ts
 */
import fs from "node:fs";
import path from "node:path";
import { getOrComputeSemantic } from "../src/services/semantic-cache.js";

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
  SEMANTIC_CACHE_NAMESPACE: "unbrowse-defer-witness",
  // Disable the L2 fuzzy tier (threshold > 1) so the call is a GUARANTEED miss —
  // otherwise a semantically-similar query from a prior run could L2-hit and no
  // write-through would be scheduled. This witness isolates the deferral behavior.
  SEMANTIC_CACHE_THRESHOLD: "1.01",
};
if (!env.EMERGENTDB_API_KEY || !env.NEBIUS_API_KEY) {
  console.error("[witness] missing EMERGENTDB_API_KEY / NEBIUS_API_KEY");
  process.exit(2);
}

const collected: Promise<unknown>[] = [];
const waitUntil = (p: Promise<unknown>) => { collected.push(p); };

// A genuinely UNIQUE query forces a fresh MISS (with L2 disabled, only an exact
// L1 hash collision could shadow it — this high-entropy string avoids that too).
const q = `defer-witness-${Math.random().toString(36).slice(2)}-${Date.now()}`;

const t0 = Date.now();
const { value, cached } = await getOrComputeSemantic(
  env,
  "defer",
  q,
  async () => "COMPUTED-VALUE",
  waitUntil,
);
const returnMs = Date.now() - t0;

// After the function returned, time how long the DEFERRED write-through still takes.
const tWrite = Date.now();
await Promise.all(collected);
const writeMs = Date.now() - tWrite;

// Deferral proof: after the function returns, the scheduled write-through is
// STILL pending and takes real EmergentDB time to finish. Had it been awaited
// inline, awaiting it post-return would be ~0ms. (returnMs is large because the
// LOOKUP — embed + vector search — is itself slow; that is separate from, and not
// what this witness tests; see the honest note below.)
const pass =
  value === "COMPUTED-VALUE" &&
  cached === false &&
  collected.length === 1 &&     // exactly one write-through was scheduled
  writeMs > 800;               // it ran AFTER return and took real EmergentDB time

console.log(`[witness] returnMs=${returnMs}  deferred-writeMs=${writeMs}  scheduled=${collected.length}  cached=${cached}`);
console.log(`[witness] ${pass
  ? `PASS — write-through deferred: it ran ${writeMs}ms AFTER the response returned (inline-await would be ~0ms post-return)`
  : "FAIL — write-through was not deferred (or not scheduled)"}`);
console.log(`[note] lookup overhead returnMs=${returnMs}ms (embed + vector search) — the semantic cache suits ops SLOWER than ~5s (captures), not fast searches.`);
process.exit(pass ? 0 : 1);
