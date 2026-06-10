/**
 * web-search.ts — unbrowse's OWN keyless web search ("find the trees").
 *
 * Replaces the former third-party paid search dependency: the backend now runs
 * its own DuckDuckGo-HTML retrieval directly from the Worker, with no external
 * API key and no per-query vendor cost. Same result shape the rest of the code
 * already consumes (url / title / score / highlights), so call sites are a
 * one-line swap and the wire contract is unchanged.
 *
 * Best-effort and fail-soft: any network/parse trouble returns [] (web search is
 * an enrichment, never on the critical path).
 */
export interface WebResult {
  url: string;
  title?: string;
  score: number;
  highlights?: string[];
}

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

export async function webSearch(query: string, numResults = 5): Promise<WebResult[]> {
  const q = query.trim();
  if (!q) return [];
  let html: string;
  try {
    const res = await fetch("https://html.duckduckgo.com/html/?q=" + encodeURIComponent(q), {
      headers: {
        // DDG blocks empty/script UAs; present a normal browser UA.
        "User-Agent": "Mozilla/5.0 (compatible; unbrowse/1.0; +https://unbrowse.ai)",
        "Accept": "text/html",
      },
      signal: AbortSignal.timeout(6_000),
    });
    if (!res.ok) {
      console.error(`[web-search] ddg failed: ${res.status} ${res.statusText}`);
      return [];
    }
    html = await res.text();
  } catch (err) {
    console.error("[web-search] fetch error:", (err as Error).message);
    return [];
  }

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
