/**
 * ddg-search.ts — keyless DuckDuckGo-HTML retrieval, CLI-side. The ZERO-COST web-search
 * fallback so `unbrowse search`/`resolve` (and anything grounding through them, e.g. the aiko
 * endpoint) return real web results with no Exa key and no x402 toll — routing cost = $0.
 *
 * Mirrors backend/src/services/web-search/providers/ddg.ts (kept in sync by hand; the backend
 * one runs in the worker, this one in the CLI). Scores are position-derived ordering only.
 */
export interface DdgHit {
  url: string;
  title?: string;
  score: number;
  highlights?: string[];
}

const RESULT_RE = /<a[^>]*class="result__a"[^>]*href="([^"]+)"[^>]*>(.*?)<\/a>/gs;
const SNIPPET_RE = /<a[^>]*class="result__snippet"[^>]*>(.*?)<\/a>/gs;

function stripTags(s: string): string {
  return s
    .replace(/<[^>]+>/g, "")
    .replace(/&amp;/g, "&")
    .replace(/&#x27;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .trim();
}

function unwrapDdg(href: string): string {
  const m = href.match(/uddg=([^&]+)/);
  if (m) {
    try {
      return decodeURIComponent(m[1]);
    } catch {
      /* fall through */
    }
  }
  return href;
}

/**
 * DDG soft-block predicate for the egress chain's body-level check.
 *
 * DuckDuckGo throttles a hot IP NOT with a 429 but with an HTTP **202 Accepted** + a ~14KB
 * "unusual traffic" anomaly page that carries ZERO `result__a` anchors (measured live: after
 * ~6 rapid queries the IP flips to 202+empty and stays there). A status-only block check
 * (0/401/403/429/≥500) accepts that 202 page, so the egress chain never escalates to the clean
 * server IP — the exact mechanism that makes a multi-resolve run self-throttle. Treat as a block:
 *   - any 202 (DDG never legitimately 202s a SERP), or
 *   - a 2xx with no result anchors AND an explicit anomaly/rate-limit marker.
 * On a block the chain advances to the server (clean IP) → residential proxy tiers.
 */
export function ddgSoftBlock(status: number, body: string): boolean {
  if (status === 202) return true;
  if (status >= 200 && status < 300) {
    const hasResults = /class="result__a"/.test(body);
    if (!hasResults && /anomaly|unusual traffic|too many requests|rate.?limit|If this error persists/i.test(body)) {
      return true;
    }
  }
  return false;
}

/**
 * Keyless DDG-HTML search. Returns up to `numResults` {url,title,score,highlights} hits.
 * Throws on a non-2xx so the caller can fall through; returns [] for an empty query.
 */
export async function ddgSearch(
  query: string,
  numResults = 5,
  fetchImpl: typeof fetch = fetch,
  timeoutMs = 6_000,
): Promise<DdgHit[]> {
  const q = query.trim();
  if (!q) return [];
  const res = await fetchImpl("https://html.duckduckgo.com/html/?q=" + encodeURIComponent(q), {
    headers: {
      "User-Agent": "Mozilla/5.0 (compatible; unbrowse/1.0; +https://unbrowse.ai)",
      Accept: "text/html",
    },
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!res.ok) throw new Error(`ddg failed: ${res.status} ${res.statusText}`);
  const html = await res.text();

  const snippets: string[] = [];
  let sm: RegExpExecArray | null;
  SNIPPET_RE.lastIndex = 0;
  while ((sm = SNIPPET_RE.exec(html))) snippets.push(stripTags(sm[1]));

  const out: DdgHit[] = [];
  let m: RegExpExecArray | null;
  RESULT_RE.lastIndex = 0;
  let idx = 0;
  while ((m = RESULT_RE.exec(html)) && out.length < numResults) {
    const url = unwrapDdg(m[1]);
    if (!url.startsWith("http")) {
      idx++;
      continue;
    }
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
