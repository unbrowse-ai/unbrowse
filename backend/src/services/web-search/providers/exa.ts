/**
 * providers/exa.ts — Exa (api.exa.ai) as the primary keyed web-search provider.
 *
 * Real neural relevance scores + highlight extraction, mapped onto the shared
 * `WebResult` shape. Requires `EXA_API_KEY`; the chain in ../index.ts only
 * schedules this provider when the key is present, and any error here throws
 * so the chain falls through to the keyless fallback.
 */
import type { WebResult } from "../types.js";

interface ExaApiResult {
  url?: string;
  title?: string | null;
  score?: number;
  highlights?: string[];
}

export async function exaSearch(
  apiKey: string,
  query: string,
  numResults = 5,
  fetchImpl: typeof fetch = fetch,
): Promise<WebResult[]> {
  const q = query.trim();
  if (!q) return [];
  const res = await fetchImpl("https://api.exa.ai/search", {
    method: "POST",
    headers: {
      "x-api-key": apiKey,
      "Content-Type": "application/json",
      "Accept": "application/json",
    },
    body: JSON.stringify({
      query: q,
      numResults: Math.min(Math.max(numResults, 1), 20),
      contents: { highlights: true },
    }),
    signal: AbortSignal.timeout(6_000),
  });
  if (!res.ok) throw new Error(`exa failed: ${res.status} ${res.statusText}`);
  const body = (await res.json().catch(() => null)) as { results?: ExaApiResult[] } | null;
  const raw = Array.isArray(body?.results) ? body.results : [];
  const out: WebResult[] = [];
  for (const r of raw) {
    if (typeof r?.url !== "string" || !r.url.startsWith("http")) continue;
    out.push({
      url: r.url,
      title: typeof r.title === "string" && r.title ? r.title : undefined,
      // Exa returns a real relevance score for neural results; fall back to
      // position-derived ordering when absent so downstream ranking never
      // sees undefined.
      score: typeof r.score === "number" ? Number(r.score.toFixed(3)) : Number((1 - out.length * 0.1).toFixed(3)),
      highlights: Array.isArray(r.highlights) && r.highlights.length > 0 ? r.highlights : undefined,
    });
    if (out.length >= numResults) break;
  }
  return out;
}
