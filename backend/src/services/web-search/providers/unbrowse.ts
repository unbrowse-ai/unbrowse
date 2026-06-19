/**
 * providers/unbrowse.ts — unbrowse's OWN web-search provider: exa-parity
 * content highlights WITHOUT api.exa.ai.
 *
 * Candidate URLs come from the keyless DDG scrape (the ranking substrate); each
 * top result is fetched and its content BM25-ranked against the query to produce
 * grounded highlights + a content-coverage score — composing primitives unbrowse
 * already owns (ddgSearch + rank-bm25), no external search API. This is "our own
 * exa" for the contents/answer case; web-scale NEURAL ranking (exa's actual moat)
 * would need a crawled embedding index and is deliberately out of scope.
 *
 * Best-effort: it trades one API call for N page fetches, so a failed enrichment
 * falls back to the raw DDG result. Web search is never on the critical path.
 */
import type { WebResult } from "../types.js";
import { ddgSearch } from "./ddg.js";
import { bm25Score } from "../../rank-bm25.js";

export function tokenize(s: string): string[] {
  return s.toLowerCase().match(/[a-z0-9]+/g) ?? [];
}

export function stripHtml(html: string): string {
  return html
    // Drop non-prose blocks whole — boilerplate + code that poisons highlights.
    .replace(/<(script|style|nav|header|footer|aside|figure|figcaption|pre|code|noscript|form)\b[\s\S]*?<\/\1>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&[a-z#0-9]+;/gi, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/** A sentence looks like real prose (not code, not a heading/caption fragment). */
function isProse(s: string): boolean {
  const words = s.split(/\s+/).filter(Boolean);
  if (words.length < 8) return false; // drop short headings ("What Causes Auroras?")
  const symbols = (s.match(/[{}();=<>|/\\[\]]/g) ?? []).length;
  if (symbols / s.length > 0.04) return false; // drop code-like fragments
  if (!/[.!?]$/.test(s)) return false; // a real sentence ends in terminal punctuation
  return true;
}

/** Top-k content sentences ranked by BM25 against the query — the "highlights".
 *  Each sentence is a doc in a tiny corpus; the existing rank-bm25 scores them. */
export function topSentences(text: string, queryTerms: string[], k: number): string[] {
  const sentences = text
    .split(/(?<=[.!?])\s+/)
    .map((s) => s.trim())
    .filter((s) => s.length >= 40 && s.length <= 400 && isProse(s));
  if (sentences.length === 0 || queryTerms.length === 0) return [];

  const docs = sentences.map(tokenize);
  const docCount = docs.length;
  const avgDl = docs.reduce((n, d) => n + d.length, 0) / docCount || 1;
  const docFreqs = new Map<string, number>();
  for (const d of docs) for (const t of new Set(d)) docFreqs.set(t, (docFreqs.get(t) ?? 0) + 1);

  return sentences
    .map((s, i) => ({ s, score: bm25Score(queryTerms, docs[i], avgDl, docCount, docFreqs) }))
    .filter((x) => x.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, k)
    .map((x) => x.s);
}

export async function unbrowseSearch(
  query: string,
  numResults = 5,
  fetchImpl: typeof fetch = fetch,
  enrichTop = 3,
): Promise<WebResult[]> {
  const candidates = await ddgSearch(query, numResults, fetchImpl);
  if (candidates.length === 0) return [];
  const queryTerms = tokenize(query);

  await Promise.all(
    candidates.slice(0, enrichTop).map(async (r) => {
      try {
        const res = await fetchImpl(r.url, {
          headers: {
            "User-Agent": "Mozilla/5.0 (compatible; unbrowse/1.0; +https://unbrowse.ai)",
            "Accept": "text/html",
          },
          signal: AbortSignal.timeout(5_000),
        });
        if (!res.ok) return;
        const text = stripHtml(await res.text());
        const highlights = topSentences(text, queryTerms, 2);
        if (highlights.length > 0) {
          r.highlights = highlights; // content-grounded, replacing the thin DDG snippet
          const lower = text.toLowerCase();
          const cov = queryTerms.filter((t) => lower.includes(t)).length / queryTerms.length;
          r.score = Number((r.score * 0.5 + cov * 0.5).toFixed(3));
        }
      } catch { /* best-effort: keep the raw DDG result */ }
    }),
  );

  candidates.sort((a, b) => b.score - a.score); // enriched (content-grounded) results bubble up
  return candidates;
}
