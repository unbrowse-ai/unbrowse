/**
 * src/sdk/adapters/firecrawl.ts — drop-in replacement for the `@mendable/firecrawl-js`
 * client.
 *
 * Same construction (`new FirecrawlApp({ apiKey })`) and the same method shapes
 * (`scrapeUrl`, `search`, `mapUrl`, `crawlUrl`) returning firecrawl-shaped results — but
 * every call routes through the wallet-sealed unbrowse hole instead of Firecrawl's API.
 * Swap the import, keep your code. Where Firecrawl bills a flat monthly plan, the hole
 * settles each call via x402 — you pay per request, only for what you actually fetch.
 * Inject a `transport`/`wallet` (HoleOptions) for tests or to bind the hole to a wallet.
 */
import { createHole, type Hole, type HoleItem, type HoleOptions } from "../hole.js";

export interface FirecrawlMetadata {
  sourceURL?: string;
  title?: string;
  description?: string;
  [key: string]: unknown;
}

export interface FirecrawlDocument {
  url?: string;
  markdown?: string;
  html?: string;
  metadata?: FirecrawlMetadata;
}

export interface ScrapeResponse extends FirecrawlDocument {
  success: boolean;
}

export interface SearchResponse {
  success: boolean;
  data: FirecrawlDocument[];
}

export interface MapResponse {
  success: boolean;
  links: string[];
}

export interface CrawlResponse {
  success: boolean;
  status: string;
  completed: number;
  total: number;
  data: FirecrawlDocument[];
}

function toDoc(it: HoleItem): FirecrawlDocument {
  const url = it.url ?? "";
  return {
    url,
    markdown: typeof it.text === "string" ? it.text : undefined,
    metadata: { sourceURL: url, title: it.title ?? undefined },
  };
}

export class FirecrawlApp {
  private readonly hole: Hole;

  constructor(opts: { apiKey?: string } & HoleOptions = {}) {
    // apiKey is accepted for drop-in compatibility but unused — the hole is
    // wallet-sealed and settles per call via x402, not a Firecrawl key.
    const { apiKey: _apiKey, ...holeOpts } = opts;
    this.hole = createHole(holeOpts);
  }

  async scrapeUrl(url: string, _params: Record<string, unknown> = {}): Promise<ScrapeResponse> {
    const r = await this.hole.fill({ intent: `contents of ${url}`, url });
    const first = r.items[0];
    const doc = toDoc(first ? { ...first, url } : { url });
    return { success: true, ...doc };
  }

  async search(query: string, params: { limit?: number } & Record<string, unknown> = {}): Promise<SearchResponse> {
    const r = await this.hole.fill({ intent: query, params });
    const n = params.limit ?? r.items.length;
    return { success: true, data: r.items.slice(0, n).map(toDoc) };
  }

  async mapUrl(url: string, _params: Record<string, unknown> = {}): Promise<MapResponse> {
    const r = await this.hole.fill({ intent: `links on ${url}`, url });
    return { success: true, links: r.items.map((it) => it.url ?? "").filter(Boolean) };
  }

  async crawlUrl(url: string, params: { limit?: number } & Record<string, unknown> = {}): Promise<CrawlResponse> {
    const r = await this.hole.fill({ intent: `crawl ${url}`, url, params });
    const n = params.limit ?? r.items.length;
    const data = r.items.slice(0, n).map(toDoc);
    return { success: true, status: "completed", completed: data.length, total: data.length, data };
  }
}

export default FirecrawlApp;
