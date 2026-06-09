/**
 * seed-bible-chapters.ts — one-time substrate seed for the internal
 * bible-anchor ranking organ (services/bible-anchor.ts).
 *
 * PRIVATE / internal. Embeds the 1189 canonical chapters so an embedded item
 * can be cosine-anchored to its nearest chapter. Two substrates, auto-detected:
 *
 *   GRAPH   (preferred) — POST /graph/batch_insert into domain `bible-chapters`,
 *           server auto-embeds (same model as skill endpoints), metadata inline.
 *   VECTORS (fallback)  — when the account has no graph instance: Nebius-embed
 *           each chapter, POST /vectors/insert, then research the content-
 *           addressed id (IQ assigns its own id + carries no metadata) and write
 *           a KV sidecar `bible-vec:<id>` -> {idx, ref} via statsKV (the same
 *           namespace the worker reads at anchor time).
 *
 * Chapter vectors live in EmergentDB, not this repo. Source read at seed time
 * from CHAPTERS_JSON (default: local lewis-brain cache). Idempotent.
 *
 * Run (needs EmergentDB key; vectors fallback also needs the Nebius key):
 *   EMERGENTDB_API_KEY=... NEBIUS_API_KEY=... bun scripts/seed-bible-chapters.ts
 *   ... bun scripts/seed-bible-chapters.ts --verify    # anchor probes only
 */

import { readFileSync } from "node:fs";
import {
  BIBLE_CHAPTERS_DOMAIN,
  BIBLE_VECTORS_NAMESPACE,
  MAX_CHAPTER_TEXT,
  chapterItemId,
  embedText,
  vecMetaKey,
} from "../src/services/bible-anchor.js";
import { statsKV } from "../src/services/kv.js";

const EMERGENTDB_BASE = "https://api.emergentdb.com";
const DEFAULT_CHAPTERS_JSON =
  "/Users/lekt9/.claude/skills/lewis-brain/strategy/.bible_cache/chapters.json";
const GRAPH_BATCH = 40;
const VEC_CONCURRENCY = 4;
const MAX_RETRY = 3;

type Chapter = { idx: number; book: string; chap: number; ref: string; text: string };

function apiKey(): string {
  const k = process.env.EMERGENTDB_API_KEY?.trim();
  if (!k) throw new Error("EMERGENTDB_API_KEY required (wrangler secret) — not set in env");
  return k;
}

async function edb(path: string, body: unknown): Promise<{ ok: boolean; status: number; json: unknown }> {
  let lastErr: unknown;
  for (let attempt = 1; attempt <= MAX_RETRY; attempt++) {
    try {
      const res = await fetch(`${EMERGENTDB_BASE}${path}`, {
        method: "POST",
        headers: { Authorization: `Bearer ${apiKey()}`, "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const text = await res.text();
      let json: unknown = null;
      try { json = JSON.parse(text); } catch { /* keep null */ }
      return { ok: res.ok, status: res.status, json };
    } catch (e) {
      lastErr = e; // socket reset / transient — back off and retry
      await new Promise((r) => setTimeout(r, 250 * attempt));
    }
  }
  throw lastErr;
}

/** Is the Graph API usable on this account? (one cheap probe insert) */
async function graphAvailable(): Promise<boolean> {
  try {
    const r = await edb("/graph/batch_insert", {
      domain: BIBLE_CHAPTERS_DOMAIN,
      items: [{ id: chapterItemId(0), text: "probe", metadata: { idx: 0, ref: "probe" } }],
    });
    return r.ok;
  } catch {
    return false; // network/socket error -> treat graph as unavailable, use vectors
  }
}

async function seedGraph(chapters: Chapter[]): Promise<void> {
  console.log(`[seed:graph] inserting ${chapters.length} chapters into domain ${BIBLE_CHAPTERS_DOMAIN}`);
  let done = 0;
  for (let i = 0; i < chapters.length; i += GRAPH_BATCH) {
    const items = chapters.slice(i, i + GRAPH_BATCH).map((c) => ({
      id: chapterItemId(c.idx),
      text: c.text.slice(0, MAX_CHAPTER_TEXT),
      metadata: { idx: c.idx, ref: c.ref, book: c.book, chap: c.chap },
    }));
    const r = await edb("/graph/batch_insert", { domain: BIBLE_CHAPTERS_DOMAIN, items });
    if (!r.ok) throw new Error(`graph batch_insert failed at ${i}: HTTP ${r.status} ${JSON.stringify(r.json)}`);
    done += items.length;
    if (done % 200 === 0 || done === chapters.length) console.log(`  ${done}/${chapters.length}`);
  }
  console.log("[seed:graph] done");
}

async function seedVectors(chapters: Chapter[]): Promise<void> {
  const env = { EMERGENTDB_API_KEY: apiKey(), NEBIUS_API_KEY: process.env.NEBIUS_API_KEY } as never;
  if (!process.env.NEBIUS_API_KEY?.trim()) throw new Error("vectors fallback needs NEBIUS_API_KEY");
  const kv = statsKV(env);
  console.log(`[seed:vectors] embedding+inserting ${chapters.length} chapters into namespace ${BIBLE_VECTORS_NAMESPACE}`);

  let done = 0, failed = 0;
  async function one(c: Chapter): Promise<void> {
    const vector = await embedText(env, c.text);
    if (!vector) { failed++; return; }
    const ins = await edb("/vectors/insert", { id: c.idx, vector, namespace: BIBLE_VECTORS_NAMESPACE });
    if (!ins.ok) { failed++; return; }
    // Research the content-addressed id IQ assigned (input id is ignored): the
    // self-search top hit is this exact vector (cosine 1.0).
    const sr = await edb("/vectors/search", { vector, k: 1, namespace: BIBLE_VECTORS_NAMESPACE });
    const id = (sr.json as { results?: Array<{ id: number }> })?.results?.[0]?.id;
    if (typeof id !== "number") { failed++; return; }
    await kv.put(vecMetaKey(id), JSON.stringify({ idx: c.idx, ref: c.ref }));
    done++;
    if (done % 100 === 0) console.log(`  ${done}/${chapters.length} (failed ${failed})`);
  }

  // Bounded concurrency pool.
  let cursor = 0;
  async function worker(): Promise<void> {
    while (cursor < chapters.length) {
      const c = chapters[cursor++];
      try { await one(c); } catch { failed++; }
    }
  }
  await Promise.all(Array.from({ length: VEC_CONCURRENCY }, () => worker()));
  console.log(`[seed:vectors] done — ${done} seeded, ${failed} failed`);
  if (done === 0) throw new Error("vectors seed wrote 0 — check NEBIUS_API_KEY + /vectors access");
}

/** Anchor witness — uses the live organ path (graph→vectors fallback). */
async function probe(query: string): Promise<void> {
  const env = { EMERGENTDB_API_KEY: apiKey(), NEBIUS_API_KEY: process.env.NEBIUS_API_KEY } as never;
  const { bibleAnchor } = await import("../src/services/bible-anchor.js");
  const a = await bibleAnchor(env, query);
  console.log(`  probe ${JSON.stringify(query.slice(0, 44))} -> ${a ? `${a.ref ?? "?"} (idx=${a.idx}, sim=${a.sim.toFixed(3)})` : "(no anchor)"}`);
}

async function main(): Promise<void> {
  apiKey(); // assert
  const verifyOnly = process.argv.includes("--verify");

  if (!verifyOnly) {
    const path = process.env.CHAPTERS_JSON ?? DEFAULT_CHAPTERS_JSON;
    const chapters = JSON.parse(readFileSync(path, "utf8")) as Chapter[];
    if (chapters.length !== 1189) console.warn(`[seed] expected 1189 chapters, got ${chapters.length}`);
    const useGraph = await graphAvailable();
    console.log(`[seed] substrate: ${useGraph ? "GRAPH" : "VECTORS (fallback — graph unavailable)"}`);
    if (useGraph) await seedGraph(chapters);
    else await seedVectors(chapters);
  }

  console.log("[seed] anchor probes (witness):");
  await probe("in the beginning God created the heavens and the earth");
  await probe("love one another as I have loved you");
  await probe("a tool that creates and initializes a new project from scratch");
}

main().catch((e) => {
  console.error("[seed] FAILED:", e instanceof Error ? e.message : String(e));
  process.exit(1);
});
