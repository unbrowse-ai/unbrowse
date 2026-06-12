/**
 * web-search/index.ts — provider-adapter web search ("find the trees").
 *
 * One interface, swappable engines. Exa (api.exa.ai) is the primary provider
 * whenever `EXA_API_KEY` is configured; the keyless DuckDuckGo scraper is the
 * zero-cost fallback. `WEB_SEARCH_PROVIDER` pins the chain explicitly:
 *
 *   unset   → exa → ddg when EXA_API_KEY is set, else ddg only
 *   "exa"   → exa → ddg (requires EXA_API_KEY; degrades to ddg with a warning)
 *   "ddg"   → ddg only
 *   "off"   → no web search (returns empty)
 *
 * Best-effort and fail-soft: a provider error or empty result falls through
 * to the next provider; the chain exhausting returns [] (web search is an
 * enrichment, never on the critical path). `webSearchWithProvider` reports
 * which engine actually produced the results so provenance can ride the wire
 * instead of a hardcoded vendor label.
 */
import type { Env } from "../../types.js";
import type { WebResult } from "./types.js";
import { ddgSearch } from "./providers/ddg.js";
import { exaSearch } from "./providers/exa.js";

export type { WebResult } from "./types.js";

export type WebSearchProviderName = "exa" | "ddg";

export interface WebSearchOutcome {
  /** Engine that actually produced the results; null when every provider came up empty. */
  provider: WebSearchProviderName | null;
  results: WebResult[];
}

type ProviderEnv = Pick<Env, "EXA_API_KEY" | "WEB_SEARCH_PROVIDER">;

/** Resolve the ordered provider chain from config. Exported for tests. */
export function webSearchProviderChain(env: ProviderEnv): WebSearchProviderName[] {
  const pin = (env.WEB_SEARCH_PROVIDER ?? "").toLowerCase().trim();
  if (pin === "off") return [];
  if (pin === "ddg") return ["ddg"];
  if (pin === "exa" && !env.EXA_API_KEY) {
    console.error("[web-search] WEB_SEARCH_PROVIDER=exa but EXA_API_KEY unset — degrading to ddg");
    return ["ddg"];
  }
  return env.EXA_API_KEY ? ["exa", "ddg"] : ["ddg"];
}

async function runProvider(
  name: WebSearchProviderName,
  env: ProviderEnv,
  query: string,
  numResults: number,
  fetchImpl: typeof fetch,
): Promise<WebResult[]> {
  switch (name) {
    case "exa":
      return exaSearch(env.EXA_API_KEY as string, query, numResults, fetchImpl);
    case "ddg":
      return ddgSearch(query, numResults, fetchImpl);
  }
}

/** Walk the provider chain; first non-empty result set wins. Never throws. */
export async function webSearchWithProvider(
  env: ProviderEnv,
  query: string,
  numResults = 5,
  fetchImpl: typeof fetch = fetch,
): Promise<WebSearchOutcome> {
  const q = query.trim();
  if (!q) return { provider: null, results: [] };
  for (const name of webSearchProviderChain(env)) {
    try {
      const results = await runProvider(name, env, q, numResults, fetchImpl);
      if (results.length > 0) return { provider: name, results };
      console.log(`[web-search] ${name} returned 0 results — trying next provider`);
    } catch (err) {
      console.error(`[web-search] ${name} error:`, (err as Error).message);
    }
  }
  return { provider: null, results: [] };
}

/** Results-only convenience wrapper (wire-compatible with the pre-adapter API). */
export async function webSearch(
  env: ProviderEnv,
  query: string,
  numResults = 5,
  fetchImpl: typeof fetch = fetch,
): Promise<WebResult[]> {
  return (await webSearchWithProvider(env, query, numResults, fetchImpl)).results;
}
