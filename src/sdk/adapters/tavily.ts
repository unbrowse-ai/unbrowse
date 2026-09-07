/**
 * src/sdk/adapters/tavily.ts — drop-in replacement for the `@tavily/core` client.
 *
 * Same construction (`tavily({ apiKey })`) and the same methods (`search`, `extract`)
 * returning tavily-shaped responses — routed through the wallet-sealed unbrowse hole.
 */
import { createHole, type HoleItem, type HoleOptions } from "../hole.js";

export interface TavilyResult {
  title: string;
  url: string;
  content: string;
  score: number;
  rawContent?: string;
}

export interface TavilySearchResponse {
  query: string;
  answer?: string;
  results: TavilyResult[];
  responseTime?: number;
}

export interface TavilyExtractResponse {
  results: Array<{ url: string; rawContent: string }>;
  failedResults: string[];
}

export interface TavilyOptions extends HoleOptions {
  apiKey?: string;
}

export interface TavilyClient {
  search(query: string, options?: Record<string, unknown>): Promise<TavilySearchResponse>;
  extract(urls: string[]): Promise<TavilyExtractResponse>;
}

function toTavily(it: HoleItem): TavilyResult {
  return {
    title: it.title ?? "",
    url: it.url ?? "",
    content: typeof it.text === "string" ? it.text : "",
    score: typeof it.score === "number" ? it.score : 0,
    rawContent: typeof it.rawContent === "string" ? (it.rawContent as string) : undefined,
  };
}

export function tavily(options: TavilyOptions = {}): TavilyClient {
  const hole = createHole(options);
  return {
    async search(query: string, opts: Record<string, unknown> = {}): Promise<TavilySearchResponse> {
      const r = await hole.fill({ intent: query, params: opts });
      return { query, answer: r.answer, results: r.items.map(toTavily) };
    },
    async extract(urls: string[]): Promise<TavilyExtractResponse> {
      const results: Array<{ url: string; rawContent: string }> = [];
      const failedResults: string[] = [];
      for (const url of urls) {
        const r = await hole.fill({ intent: `extract ${url}`, url });
        const text = r.items[0]?.text;
        if (typeof text === "string" && text) results.push({ url, rawContent: text });
        else failedResults.push(url);
      }
      return { results, failedResults };
    },
  };
}

export default tavily;
