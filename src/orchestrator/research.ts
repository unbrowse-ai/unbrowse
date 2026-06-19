// research.ts — native research primitive (Tavily parity), built on unbrowse's own
// machinery: ddgSearch (pointers) -> fetchDirectDocument (values) -> focusMarkdownToIntent
// (ground). The query is a HOLE; search resolves ranked URL POINTERS; fetch resolves the
// page-markdown VALUES; synthesis grounds a cited answer. No external research API, no model
// call required (extractive synthesis keeps it native + dependency-free).
import { ddgSearch } from "../lib/ddg-search.js";
import { fetchDirectDocument, focusMarkdownToIntent } from "./direct-document.js";

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
  const empty: ResearchAnswer = { query: q, answer: "", citations: [], results: [] };
  if (!q) return empty;

  // 1. SEARCH — resolve ranked URL pointers (native DDG SERP; throws on non-2xx).
  let hits: Awaited<ReturnType<typeof ddgSearch>>;
  try {
    hits = await ddgSearch(q, numResults);
  } catch {
    return empty; // SERP unavailable -> honest empty, not a fabricated answer.
  }
  if (!hits.length) return empty;

  // 2. EXTRACT — resolve page-markdown values for the top-k pointers, concurrently.
  const fetched = await Promise.all(
    hits.slice(0, numResults).map(async (h) => {
      try {
        const doc = await fetchDirectDocument(h.url);
        if (!doc || !doc.markdown) return null;
        const focused = focusMarkdownToIntent(doc.markdown, q, budget);
        if (!focused.trim()) return null;
        return { url: doc.url || h.url, title: doc.title || h.title || h.url, focused, score: h.score };
      } catch {
        return null; // a single source failing must not sink the research.
      }
    }),
  );
  const sources = fetched.filter((x): x is NonNullable<typeof x> => x !== null);
  if (!sources.length) return empty;

  // 3. SYNTHESIZE — extractive cited answer: the leading focused excerpts from the
  //    highest-scoring sources, each attributed. (A model-backed synthesis is a later
  //    lever; extractive keeps this native + dependency-free and never fabricates.)
  // Only sources whose focused excerpt yields a real prose quote become citations — an
  // empty quote means the page was all nav/chrome, so it is not a usable source.
  const cited = sources
    .map((s) => ({ s, quote: bestSentences(s.focused, q, 2) }))
    .filter((x) => x.quote.trim().length > 0);
  if (!cited.length) return empty; // every fetched page was chrome-only -> honest empty.

  const citations: ResearchCitation[] = cited.map(({ s, quote }) => ({ url: s.url, title: s.title, quote }));
  const results: ResearchResult[] = cited.map(({ s }) => ({
    url: s.url,
    title: s.title,
    content: s.focused,
    score: s.score,
  }));
  const answer = citations.map((c) => c.quote).join(" ").slice(0, budget * 2);

  return { query: q, answer, citations, results };
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
    line = line.replace(/^#{1,6}\s*/, "").replace(/[*_`>|]+/g, " ").replace(/\s+/g, " ").trim();
    if (!line) continue;
    const letters = (line.match(/[a-zA-Z]/g) ?? []).length;
    if (letters < 20) continue; // letter-poor fragment
    if (linkCount >= 3 && letters < line.length * 0.5) continue; // link-dense nav residue
    kept.push(line);
  }
  return kept.join(" ").replace(/\s+/g, " ").trim();
}
