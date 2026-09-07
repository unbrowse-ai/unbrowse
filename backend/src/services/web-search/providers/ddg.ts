/**
 * providers/ddg.ts — keyless DuckDuckGo-HTML retrieval, the zero-cost fallback
 * provider in the web-search chain. No API key, no per-query vendor cost.
 *
 * Scores are position-derived (1.0, 0.9, …) — ordering information only, not
 * relevance. Callers that need real relevance scores should prefer a keyed
 * provider (exa) ahead of this one in the chain.
 */
import type { WebResult } from "../types.js";

const RESULT_RE =
  /<a[^>]*class="result__a"[^>]*href="([^"]+)"[^>]*>(.*?)<\/a>/gs;
const SNIPPET_RE = /<a[^>]*class="result__snippet"[^>]*>(.*?)<\/a>/gs;

function stripTags(s: string): string {
  return s.replace(/<[^>]+>/g, "").replace(/&amp;/g, "&").replace(/&#x27;/g, "'")
    .replace(/&quot;/g, '"').replace(/&lt;/g, "<").replace(/&gt;/g, ">").trim();
}

function unwrapDdg(href: string): string {
  const m = href.match(/uddg=([^&]+)/);
  if (m) {
    try { return decodeURIComponent(m[1]); } catch { /* fall through */ }
  }
  return href;
}

export async function ddgSearch(
  query: string,
  numResults = 5,
  fetchImpl: typeof fetch = fetch,
): Promise<WebResult[]> {
  const q = query.trim();
  if (!q) return [];
  const res = await fetchImpl("https://html.duckduckgo.com/html/?q=" + encodeURIComponent(q), {
    headers: {
      // DDG blocks empty/script UAs; present a normal browser UA.
      "User-Agent": "Mozilla/5.0 (compatible; unbrowse/1.0; +https://unbrowse.ai)",
      "Accept": "text/html",
    },
    signal: AbortSignal.timeout(6_000),
  });
  if (!res.ok) throw new Error(`ddg failed: ${res.status} ${res.statusText}`);
  const html = await res.text();

  // Snippets in document order line up with results in document order.
  const snippets: string[] = [];
  let sm: RegExpExecArray | null;
  SNIPPET_RE.lastIndex = 0;
  while ((sm = SNIPPET_RE.exec(html))) snippets.push(stripTags(sm[1]));

  const out: WebResult[] = [];
  let m: RegExpExecArray | null;
  RESULT_RE.lastIndex = 0;
  let idx = 0;
  while ((m = RESULT_RE.exec(html)) && out.length < numResults) {
    const url = unwrapDdg(m[1]);
    if (!url.startsWith("http")) { idx++; continue; }
    const title = stripTags(m[2]);
    const snip = snippets[idx];
    out.push({
      url,
      title: title || undefined,
      score: Number((1 - out.length * 0.1).toFixed(3)),
      highlights: snip ? [snip] : undefined,
    });
    idx++;
  }
  return out;
}
