// research.ts — native research primitive (Tavily parity), built on unbrowse's own
// machinery: ddgSearch (pointers) -> fetchDirectDocument (values) -> focusMarkdownToIntent
// (ground). The query is a HOLE; search resolves ranked URL POINTERS; fetch resolves the
// page-markdown VALUES; synthesis grounds a cited answer. No external research API, no model
// call required (extractive synthesis keeps it native + dependency-free).
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync, mkdirSync, statSync, readdirSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { tmpdir, homedir } from "node:os";
import { ddgSearch } from "../lib/ddg-search.js";
import { fetchDirectDocument, focusMarkdownToIntent } from "./direct-document.js";

// Read cache for the per-source fetch (the ~18s cost of the resolve→read→ground walk). A repeat
// read of the same URL within TTL is served from disk → research/extract get near-instant on warm
// sources. On by default with a conservative TTL; disable with UNBROWSE_RESEARCH_CACHE=0.
const CACHE_ON = process.env.UNBROWSE_RESEARCH_CACHE !== "0";
const CACHE_TTL_MS = Number(process.env.UNBROWSE_RESEARCH_CACHE_TTL_MS ?? 900_000) || 900_000;
const CACHE_MAX = Number(process.env.UNBROWSE_RESEARCH_CACHE_MAX ?? 500) || 500;
function cacheDir(): string {
  const base = process.env.UNBROWSE_RESEARCH_CACHE_DIR || join(homedir() || tmpdir(), ".cache", "unbrowse", "research");
  try { mkdirSync(base, { recursive: true }); } catch { /* best-effort */ }
  return base;
}
function cachePath(url: string): string {
  return join(cacheDir(), createHash("sha256").update(url).digest("hex").slice(0, 32) + ".json");
}
function cacheRead(url: string): ExtractedDoc | null {
  if (!CACHE_ON) return null;
  try {
    const p = cachePath(url);
    if (Date.now() - statSync(p).mtimeMs > CACHE_TTL_MS) return null; // stale
    const doc = JSON.parse(readFileSync(p, "utf8")) as ExtractedDoc;
    return doc && doc.ok ? { ...doc, cached: true } : null;
  } catch { return null; }
}
function cacheWrite(url: string, doc: ExtractedDoc): void {
  if (!CACHE_ON || !doc.ok) return;
  try {
    writeFileSync(cachePath(url), JSON.stringify({ ...doc, cached: false }));
    sweepCache(cacheDir(), CACHE_MAX); // bound the store: a cache without eviction is an unbounded hole
  } catch { /* best-effort */ }
}

/** Evict oldest entries so the read-cache never grows past `maxEntries` (newest kept).
 *  Exported so the boundary is witnessable. No-op when under cap. */
export function sweepCache(dir: string, maxEntries: number): number {
  try {
    const files = readdirSync(dir).filter((f) => f.endsWith(".json"));
    if (files.length <= maxEntries) return 0;
    const withMtime = files.map((f) => {
      const p = join(dir, f);
      try { return { p, m: statSync(p).mtimeMs }; } catch { return { p, m: 0 }; }
    });
    withMtime.sort((a, b) => a.m - b.m); // oldest first
    const evict = withMtime.slice(0, withMtime.length - maxEntries);
    for (const e of evict) { try { unlinkSync(e.p); } catch { /* race ok */ } }
    return evict.length;
  } catch { return 0; }
}

export interface ResearchCitation {
  url: string;
  title: string;
  /** The query-focused excerpt from THIS source that supports the answer. */
  quote: string;
}

export interface ResearchResult {
  url: string;
  title: string;
  /** The fetched page content (query-focused markdown excerpt). Tavily.results[].content parity. */
  content: string;
  score: number;
}

export interface ResearchAnswer {
  query: string;
  /** Synthesized cited answer, built ONLY from fetched sources. Empty string if nothing fetched. */
  answer: string;
  citations: ResearchCitation[];
  results: ResearchResult[];
  /** When the answer is empty, WHY — so an empty result is never a silent failure
   *  (distinguishes empty query / rate-limited search / no results / unreadable sources). */
  note?: string;
}

export interface ResearchOptions {
  /** How many SERP hits to consider (and fetch top-k of). Default 5. */
  numResults?: number;
  /** Per-source focused-excerpt budget in chars. Default 1200. */
  perSourceBudget?: number;
}

/**
 * doResearch — search -> extract -> synthesized cited answer, natively.
 * Honest-empty: if no source fetches, answer="" and citations=[] (never fabricated).
 */
export async function doResearch(query: string, opts: ResearchOptions = {}): Promise<ResearchAnswer> {
  const q = (query ?? "").trim();
  const numResults = opts.numResults ?? 5;
  const budget = opts.perSourceBudget ?? 1200;
  const emptyWith = (note: string): ResearchAnswer => ({ query: q, answer: "", citations: [], results: [], note });
  if (!q) return emptyWith("empty query");

  // 1. SEARCH — resolve ranked URL pointers (native DDG SERP). One retry with a short backoff
  //    absorbs transient rate-limiting; a persistent empty is surfaced (not silently blank).
  let hits: Awaited<ReturnType<typeof ddgSearch>> = [];
  let serpError = false;
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      hits = await ddgSearch(q, numResults);
      if (hits.length) break;
    } catch {
      serpError = true;
    }
    if (attempt === 0 && !hits.length) await new Promise((r) => setTimeout(r, 600));
  }
  if (!hits.length) {
    return emptyWith(serpError ? "search unavailable (possibly rate-limited)" : "no search results (search may be rate-limited)");
  }

  // 2. READ — the SAME read step `extract` exposes (readSource), per pointer, concurrently;
  //    then focus each source's value to the intent. One read path, not two.
  const fetched = await Promise.all(
    hits.slice(0, numResults).map(async (h) => {
      const doc = await readSource(h.url); // shared with doExtract
      if (!doc) return null; // a single source failing must not sink the research.
      const focused = focusMarkdownToIntent(doc.raw_content, q, budget);
      if (!focused.trim()) return null;
      return { url: doc.url, title: doc.title || h.title || h.url, focused, score: h.score };
    }),
  );
  const sources = fetched.filter((x): x is NonNullable<typeof x> => x !== null);
  if (!sources.length) return emptyWith("no readable sources fetched");

  // 3. SYNTHESIZE — extractive cited answer: the leading focused excerpts from the
  //    highest-scoring sources, each attributed. (A model-backed synthesis is a later
  //    lever; extractive keeps this native + dependency-free and never fabricates.)
  // Only sources whose focused excerpt yields a real prose quote become citations — an
  // empty quote means the page was all nav/chrome, so it is not a usable source.
  const cited = sources
    .map((s) => ({ s, quote: bestSentences(s.focused, q, 2) }))
    .filter((x) => x.quote.trim().length > 0);
  if (!cited.length) return emptyWith("sources fetched but no quotable prose"); // every fetched page was chrome-only -> honest empty.

  const citations: ResearchCitation[] = cited.map(({ s, quote }) => ({ url: s.url, title: s.title, quote }));
  const results: ResearchResult[] = cited.map(({ s }) => ({
    url: s.url,
    title: s.title,
    content: s.focused,
    score: s.score,
  }));
  // Cross-source synthesis: pool every prose sentence from every cited source, rank by
  // query-term relevance across the whole set, dedup, and keep the best few. A fact stated
  // by a lower-ranked source still surfaces over a top source's title line.
  const answer = synthesizeAnswer(cited.map((c) => c.s.focused), q, 3) || citations[0].quote;

  return { query: q, answer, citations, results };
}

export interface ExtractedDoc {
  url: string;
  title: string;
  /** Clean prose (markdown/nav cruft stripped) — Tavily-style extracted content. */
  content: string;
  /** The full page markdown before prose-cleaning — Tavily.raw_content parity. */
  raw_content: string;
  ok: boolean;
  /** True when this read was served from the warm read-cache (perf signal). */
  cached?: boolean;
}

/**
 * readSource — THE shared read step of the resolve→read→ground walk: resolve one URL hole to
 * its value (clean content + raw markdown) via unbrowse's own document path. Returns null on
 * failure (never throws, never fabricates). Both `extract` (exposes it) and `research`
 * (consumes it per source) go through THIS one function — they are one read path, not two.
 */
export async function readSource(url: string): Promise<ExtractedDoc | null> {
  const warm = cacheRead(url); // perf: warm read-cache hit -> skip the ~18s fetch
  if (warm) return warm;
  try {
    const doc = await fetchDirectDocument(url);
    if (!doc || !doc.markdown) return null;
    const out: ExtractedDoc = { url: doc.url || url, title: doc.title || url, content: cleanProse(doc.markdown), raw_content: doc.markdown, ok: true, cached: false };
    cacheWrite(url, out);
    return out;
  } catch {
    return null;
  }
}

export interface MappedLink { url: string; text: string }

/**
 * doMap — Tavily `/map` parity, native: resolve a URL hole to its POINTERS (the outgoing
 * absolute links on the page), via the same cached `readSource`. The pointers face of the
 * read (extract = the value face). Honest-empty on a failed/linkless page.
 */
export async function doMap(url: string): Promise<{ url: string; links: MappedLink[] }> {
  const u = (url ?? "").trim();
  if (!u) return { url: "", links: [] };
  const doc = await readSource(u);
  if (!doc) return { url: u, links: [] };
  const links: MappedLink[] = [];
  const seen = new Set<string>();
  const re = /\[([^\]]*)\]\((https?:\/\/[^)\s]+)\)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(doc.raw_content)) !== null) {
    const href = m[2];
    if (seen.has(href)) continue;
    seen.add(href);
    links.push({ url: href, text: m[1].replace(/\s+/g, " ").trim() });
  }
  return { url: doc.url, links };
}

/**
 * doExtract — Tavily `/extract` parity = `readSource` exposed in batch. A URL that fails comes
 * back `ok:false` with empty content (honest, never fabricated).
 */
export async function doExtract(urls: string[]): Promise<{ results: ExtractedDoc[] }> {
  const list = (urls ?? []).map((u) => (u ?? "").trim()).filter(Boolean);
  if (!list.length) return { results: [] };
  const results = await Promise.all(
    list.map(async (url): Promise<ExtractedDoc> =>
      (await readSource(url)) ?? { url, title: "", content: "", raw_content: "", ok: false },
    ),
  );
  return { results };
}

/** Cross-source synthesis: pool prose sentences from all sources, rank by query-term
 *  relevance over the whole set, dedup near-duplicates, return the best N joined. Only
 *  sentences that actually mention a query term qualify (so titles/chrome with 0 hits are
 *  excluded), keeping the answer fact-bearing and grounded in the fetched text. */
function synthesizeAnswer(focusedTexts: string[], query: string, n: number): string {
  const terms = [...new Set((query.toLowerCase().match(/[a-z][a-z0-9]{2,}/g) ?? []))];
  if (!terms.length) return "";
  const pool: { s: string; hits: number }[] = [];
  for (const text of focusedTexts) {
    const sents = cleanProse(text).match(/[^.!?]+[.!?]+|\S[^.!?]*$/g)?.map((s) => s.trim()).filter(Boolean) ?? [];
    for (const s of sents) {
      const low = s.toLowerCase();
      const hits = terms.reduce((a, t) => a + (low.includes(t) ? 1 : 0), 0);
      if (hits > 0) pool.push({ s, hits });
    }
  }
  if (!pool.length) return "";
  pool.sort((a, b) => b.hits - a.hits || a.s.length - b.s.length);
  const picked: string[] = [];
  const seen = new Set<string>();
  for (const { s } of pool) {
    const key = s.toLowerCase().replace(/[^a-z0-9]+/g, "").slice(0, 60);
    if (seen.has(key)) continue;
    seen.add(key);
    picked.push(s);
    if (picked.length >= n) break;
  }
  return picked.join(" ").trim();
}

/** The N most query-relevant prose sentences of a focused excerpt — the quotable kernel
 *  for a citation. Cleans markdown/nav cruft, then ranks sentences by how many query terms
 *  they contain (so the quote carries the FACT, not the page title), restored to reading order. */
function bestSentences(text: string, query: string, n: number): string {
  const prose = cleanProse(text);
  const sents = prose.match(/[^.!?]+[.!?]+|\S[^.!?]*$/g)?.map((s) => s.trim()).filter(Boolean) ?? [];
  if (sents.length <= n) return sents.join(" ").trim();
  const terms = [...new Set((query.toLowerCase().match(/[a-z][a-z0-9]{2,}/g) ?? []))];
  const scored = sents.map((s, i) => {
    const low = s.toLowerCase();
    return { s, i, hits: terms.reduce((a, t) => a + (low.includes(t) ? 1 : 0), 0) };
  });
  const top = scored
    .slice()
    .sort((a, b) => b.hits - a.hits || a.i - b.i)
    .slice(0, n)
    .sort((a, b) => a.i - b.i); // restore reading order
  return top.map((x) => x.s).join(" ").trim();
}

/** Turn focused markdown into plain prose: unwrap [label](url) -> label, drop heading
 *  markers, and keep only lines that read like prose (enough letters, not link-dense). */
export function cleanProse(md: string): string {
  const kept: string[] = [];
  for (const raw of md.split(/\n+/)) {
    // Nav-detection FIRST, on the RAW line: menus/sidebars are link-dense or list-of-links.
    // A line with >=2 link/image markers, or a list item that is mostly a single link, is
    // chrome — drop it whole rather than try to salvage prose from it.
    // Nav bullets ("- [Link](..)") are pure chrome; drop them whole. Link-dense prose
    // (e.g. Wikipedia body) is kept — bestSentences() will pick the fact-bearing lines.
    if (/^\s*[-*]\s*\[/.test(raw)) continue;

    let line = raw.replace(/!\[[^\]]*\]\([^)]*\)/g, " "); // images
    line = line.replace(/\[\\?\[?\d+\\?\]?\]?\([^)]*\)/g, " "); // footnote refs [[7]](#cite..)
    line = line.replace(/\[\d+\]/g, " "); // bare [7] ref leftovers
    const linkCount = (line.match(/\]\([^)]*\)/g) ?? []).length;
    line = line.replace(/\[([^\]]+)\]\([^)]*\)/g, "$1"); // [label](url) -> label
    line = line.replace(/\[\s*\]\([^)]*\)/g, " "); // empty-label links [](url)
    line = line.replace(/\]\([^\s)]*\)?/g, " "); // orphan "](url" from a budget-truncated link
    line = line.replace(/https?:\/\/\S+/g, " "); // bare/cruft URLs
    line = line.replace(/\S*#ref\d+\)?/g, " "); // truncated url-anchor fragments (#ref41179))
    line = line.replace(/\s+\)/g, " "); // orphan close-paren left by a stripped link
    line = line.replace(/^#{1,6}\s*/, "").replace(/[*_`>|]+/g, " ").replace(/\s+/g, " ").trim();
    if (!line) continue;
    const letters = (line.match(/[a-zA-Z]/g) ?? []).length;
    if (letters < 20) continue; // letter-poor fragment
    if (linkCount >= 3 && letters < line.length * 0.5) continue; // link-dense nav residue
    kept.push(line);
  }
  return kept.join(" ").replace(/\s+/g, " ").trim();
}
