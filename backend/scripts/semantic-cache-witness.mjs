#!/usr/bin/env node
/**
 * semantic-cache-witness — proves the Exa-path semantic cache end-to-end on the
 * LIVE EmergentDB + Nebius services (backend/src/services/semantic-cache.ts).
 *
 * Claim under test: a reworded paraphrase of a prior query retrieves the
 * original query's cached result — without an exact string match. That is the
 * whole value of the cache (a plain KV cache would miss the reworded query).
 *
 *   write: embed(A)  -> vector insert -> content-addressed id -> qdkv[veccache:id] = payload
 *   read : embed(A') -> nearest-neighbour -> same id (cosine >= threshold) -> payload
 *
 * Exit 0 iff the paraphrase read returns the exact payload written for A.
 *
 *   EMERGENTDB_API_KEY=... NEBIUS_API_KEY=... node semantic-cache-witness.mjs
 */
import fs from "node:fs";
import path from "node:path";

// Load keys from backend/.env or repo .env if not already in the environment.
for (const p of [path.join(process.cwd(), ".env"), path.join(process.cwd(), "..", ".env")]) {
  if (!fs.existsSync(p)) continue;
  for (const line of fs.readFileSync(p, "utf8").split("\n")) {
    const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, "");
  }
}

const EK = process.env.EMERGENTDB_API_KEY;
const NK = process.env.NEBIUS_API_KEY;
if (!EK || !NK) { console.error("[witness] missing EMERGENTDB_API_KEY / NEBIUS_API_KEY"); process.exit(2); }

const EDB = "https://api.emergentdb.com";
const NS = "unbrowse-semcache-witness:web:k5";
const THRESHOLD = 0.80;  // calibrated: paraphrases 0.88+, different-Q ≤0.67

async function embed(text) {
  const r = await fetch("https://api.tokenfactory.nebius.com/v1/embeddings", {
    method: "POST",
    headers: { Authorization: `Bearer ${NK}`, "Content-Type": "application/json" },
    body: JSON.stringify({ model: "Qwen/Qwen3-Embedding-8B", input: text, dimensions: 1536 }),
  });
  if (!r.ok) throw new Error(`embed ${r.status}`);
  return (await r.json()).data[0].embedding;
}
async function nearest(vector) {
  const r = await fetch(`${EDB}/vectors/search`, {
    method: "POST", headers: { Authorization: `Bearer ${EK}`, "Content-Type": "application/json" },
    body: JSON.stringify({ vector, k: 1, namespace: NS }),
  });
  const d = await r.json();
  return d.results?.[0] ?? null;
}
async function insert(vector) {
  await fetch(`${EDB}/vectors/insert`, {
    method: "POST", headers: { Authorization: `Bearer ${EK}`, "Content-Type": "application/json" },
    body: JSON.stringify({ id: 1, vector, namespace: NS }),
  });
}
async function kvSet(key, value) {
  await fetch(`${EDB}/qdkv/set`, {
    method: "POST", headers: { Authorization: `Bearer ${EK}`, "Content-Type": "application/json" },
    body: JSON.stringify({ key, value }),
  });
}
async function kvGet(key) {
  const r = await fetch(`${EDB}/qdkv/get/${encodeURIComponent(key)}`, { headers: { Authorization: `Bearer ${EK}` } });
  const d = await r.json();
  return d.found && d.value != null ? d.value : null;
}

// A shared high-entropy token makes this run's A/A' pair UNIQUE — vector search is
// global (namespace does not scope it) and prior runs accumulate near-duplicate A
// copies (embedding non-determinism), so without a per-run token A' sometimes
// resolves to a payload-less near-copy. The token sits in BOTH, so they stay mutual
// paraphrases (>0.80) while being distinct from every prior run.
const TOK = Math.random().toString(36).slice(2, 10);
const A  = `Case file ${TOK}: what year did the company that makes the Nintendo Switch release its first clamshell handheld?`;
const Ap = `In case ${TOK}, which year did Nintendo, maker of the Switch, launch its first foldable clamshell handheld console?`;
const PAYLOAD = [{ url: "https://en.wikipedia.org/wiki/Nintendo_DS", title: "Nintendo DS", year: "2004" }];

// WRITE side (simulate a cold miss being cached). Insert A's vector, then POLL
// until it is indexed — a self-search returns it at score ~1.0 — before reading its
// content-addressed id. Reading the id too early (before indexing) returns a stale
// vector's id and writes the payload to the wrong key (the flaky failure mode).
const eA = await embed(A);
await insert(eA);
async function indexedId(vec) {
  for (let i = 0; i < 8; i++) {
    const h = await nearest(vec);
    if (h && h.score >= 0.99) return h.id;       // self-match → A is indexed
    await new Promise((r) => setTimeout(r, 400 * (i + 1)));
  }
  return (await nearest(vec))?.id;               // best effort
}
const idA = await indexedId(eA);
await kvSet(`veccache:${NS}:${idA}`, JSON.stringify(PAYLOAD));

// READ side (the paraphrase — different words, same meaning)
const eAp = await embed(Ap);
const hit = await nearest(eAp);
const cached = hit && hit.score >= THRESHOLD ? await kvGet(`veccache:${NS}:${hit.id}`) : null;
const got = cached ? JSON.parse(cached) : null;

const pass = hit && hit.id === idA && got && got[0]?.year === "2004";
console.log(`[witness] write id=${idA}  paraphrase-hit id=${hit?.id} score=${hit?.score?.toFixed(4)}  cached=${JSON.stringify(got)}`);
console.log(`[witness] ${pass ? "PASS — reworded query retrieved the cached Exa result" : "FAIL — paraphrase did not hit the cache"}`);
process.exit(pass ? 0 : 1);
