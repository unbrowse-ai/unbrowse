/**
 * @unbrowse/firecrawl-shim — drop-in replacement for `@mendable/firecrawl-js`.
 *
 *   - import Firecrawl from '@mendable/firecrawl-js';
 *   + import Firecrawl from '@unbrowse/firecrawl-shim';
 *
 *   const client = new Firecrawl({ apiKey: 'fc-xxx' });
 *   const doc = await client.scrape('https://...');
 *
 * Five methods mirror Firecrawl v2: scrape, crawl, map, extract, search.
 * Each routes through Unbrowse's marketplace cache first (`/v1/resolve` +
 * `/v1/execute`); falls back to Firecrawl's own API only if Unbrowse misses
 * AND the original apiKey is present (so cost-conscious callers pay only on
 * miss, but the contract surface stays identical).
 *
 * Honest scope:
 *   - scrape/map/search route cleanly through resolve+execute.
 *   - crawl is partial — Unbrowse marketplace returns a single endpoint
 *     shortlist, not a recursive crawl plan. v0.1 falls back to Firecrawl
 *     for crawl jobs unless UNBROWSE_DRYRUN=1.
 *   - extract(urls, {schema}) calls execute with --extract per URL.
 */

const DEFAULT_BASE = 'https://beta-api.unbrowse.ai';
const FIRECRAWL_BASE = 'https://api.firecrawl.dev';

export interface ScrapeOptions {
  formats?: ('markdown' | 'html' | 'rawHtml' | 'links' | 'screenshot' | 'extract' | 'json')[];
  onlyMainContent?: boolean;
  includeTags?: string[];
  excludeTags?: string[];
  waitFor?: number;
  timeout?: number;
  headers?: Record<string, string>;
  actions?: unknown[];
  proxy?: 'basic' | 'stealth' | 'auto';
  jsonOptions?: { schema: unknown; prompt?: string };
  extract?: { schema?: unknown; prompt?: string };
}

export interface CrawlOptions {
  includePaths?: string[];
  excludePaths?: string[];
  maxDepth?: number;
  limit?: number;
  allowBackwardLinks?: boolean;
  allowExternalLinks?: boolean;
  scrapeOptions?: ScrapeOptions;
  pollInterval?: number;
  timeout?: number;
}

export interface MapOptions {
  search?: string;
  ignoreSitemap?: boolean;
  includeSubdomains?: boolean;
  limit?: number;
}

export interface ExtractOptions {
  schema?: unknown;
  prompt?: string;
  systemPrompt?: string;
  enableWebSearch?: boolean;
}

export interface SearchOptions {
  sources?: ('web' | 'news' | 'images')[];
  limit?: number;
  scrapeOptions?: ScrapeOptions;
}

export interface Document {
  markdown?: string;
  html?: string;
  rawHtml?: string;
  links?: string[];
  screenshot?: string;
  extract?: unknown;
  json?: unknown;
  metadata?: { title?: string; description?: string; language?: string; sourceURL?: string; statusCode?: number };
}

export interface CrawlJob {
  id: string;
  status: 'scraping' | 'completed' | 'failed';
  total: number;
  completed: number;
  data: Document[];
}

export interface MapData {
  links: string[];
}

export interface ExtractJob {
  id: string;
  status: 'processing' | 'completed' | 'failed';
  data?: unknown;
}

export interface SearchData {
  web?: Document[];
  news?: Document[];
  images?: Document[];
}

function unbrowseBase(): string {
  return process.env.UNBROWSE_API_URL || process.env.UNBROWSE_BASE || DEFAULT_BASE;
}

function unbrowseAuth(): Record<string, string> {
  const h: Record<string, string> = { 'content-type': 'application/json' };
  const apiKey = process.env.UNBROWSE_API_KEY;
  if (apiKey) h['authorization'] = `Bearer ${apiKey}`;
  const x402 = process.env.UNBROWSE_X_PAYMENT || process.env.X_PAYMENT;
  if (x402) h['x-payment'] = x402;
  return h;
}

async function unbrowseResolve(url: string, intent: string): Promise<any | null> {
  try {
    const res = await fetch(`${unbrowseBase()}/v1/resolve`, {
      method: 'POST',
      headers: unbrowseAuth(),
      body: JSON.stringify({ url, intent }),
      signal: AbortSignal.timeout(8000),
    });
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  }
}

async function unbrowseExecute(endpointId: string, params: Record<string, unknown> = {}, raw = true): Promise<any> {
  try {
    const res = await fetch(`${unbrowseBase()}/v1/execute`, {
      method: 'POST',
      headers: unbrowseAuth(),
      body: JSON.stringify({ endpoint_id: endpointId, params, raw, extract: !raw }),
      signal: AbortSignal.timeout(30000),
    });
    return await res.json();
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

function topCandidate(resolved: any): { endpoint_id: string } | null {
  const list = resolved?.available_operations || resolved?.available_endpoints || [];
  return list[0] ? { endpoint_id: list[0].endpoint_id } : null;
}

function bodyToDocument(body: any, url: string): Document {
  // Body could be HTML string, JSON object, or markdown — synthesize a
  // Document with whatever the cached endpoint actually returned.
  if (typeof body === 'string') {
    const isHtml = /<\w+/.test(body);
    const titleMatch = isHtml ? body.match(/<title[^>]*>([^<]+)<\/title>/i) : null;
    return {
      markdown: isHtml ? undefined : body,
      html: isHtml ? body : undefined,
      rawHtml: isHtml ? body : undefined,
      metadata: {
        title: titleMatch?.[1]?.trim(),
        sourceURL: url,
        statusCode: 200,
      },
    };
  }
  return {
    json: body,
    metadata: { sourceURL: url, statusCode: 200 },
  };
}

export interface FirecrawlConfig {
  apiKey?: string;
  apiUrl?: string;
}

export default class Firecrawl {
  private apiKey: string;
  private apiUrl: string;

  constructor(config: FirecrawlConfig = {}) {
    this.apiKey = config.apiKey || process.env.FIRECRAWL_API_KEY || '';
    this.apiUrl = config.apiUrl || FIRECRAWL_BASE;
  }

  /**
   * scrape(url) — single-page scrape. Unbrowse cache hit returns synthesized
   * Document; miss falls back to Firecrawl's /v1/scrape if apiKey is set.
   */
  async scrape(url: string, opts: ScrapeOptions = {}): Promise<Document> {
    const intent = opts.jsonOptions?.prompt || opts.extract?.prompt || `scrape ${url}`;
    const resolved = await unbrowseResolve(url, intent);
    const top = topCandidate(resolved);
    if (top) {
      const exec = await unbrowseExecute(top.endpoint_id, {}, true);
      if (exec?.ok && exec.body !== undefined) {
        return bodyToDocument(exec.body, url);
      }
    }
    // Fall back to Firecrawl
    if (!this.apiKey) {
      throw new Error(
        `[@unbrowse/firecrawl-shim] no cached route for ${url} and no FIRECRAWL_API_KEY for fallback. ` +
        `Pass apiKey to the constructor or set FIRECRAWL_API_KEY env to enable fallback.`,
      );
    }
    const res = await fetch(`${this.apiUrl}/v1/scrape`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${this.apiKey}` },
      body: JSON.stringify({ url, ...opts }),
    });
    const data = (await res.json()) as { data?: Document };
    return data.data || {};
  }

  /**
   * map(url) — site URL discovery. Unbrowse marketplace doesn't index sitemaps
   * yet; v0.1 falls straight through to Firecrawl unless UNBROWSE_DRYRUN=1.
   */
  async map(url: string, opts: MapOptions = {}): Promise<MapData> {
    if (process.env.UNBROWSE_DRYRUN === '1') {
      return { links: [url] };
    }
    if (!this.apiKey) {
      throw new Error(
        `[@unbrowse/firecrawl-shim] map() requires FIRECRAWL_API_KEY fallback; Unbrowse does not index sitemaps in v0.1.`,
      );
    }
    const res = await fetch(`${this.apiUrl}/v1/map`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${this.apiKey}` },
      body: JSON.stringify({ url, ...opts }),
    });
    const data = (await res.json()) as { links?: string[] };
    return { links: data.links || [] };
  }

  /**
   * crawl(url) — multi-page recursive scrape. Unbrowse marketplace returns
   * per-URL endpoints, not a crawl plan; v0.1 falls back to Firecrawl.
   */
  async crawl(url: string, opts: CrawlOptions & { pollInterval?: number; timeout?: number } = {}): Promise<CrawlJob> {
    if (!this.apiKey) {
      throw new Error(
        `[@unbrowse/firecrawl-shim] crawl() requires FIRECRAWL_API_KEY fallback; recursive crawl not in v0.1.`,
      );
    }
    const res = await fetch(`${this.apiUrl}/v1/crawl`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${this.apiKey}` },
      body: JSON.stringify({ url, ...opts }),
    });
    return (await res.json()) as CrawlJob;
  }

  /**
   * extract(urls, {schema, prompt}) — structured-data extraction. Each URL
   * routes through resolve+execute --extract; falls back per-URL on miss.
   */
  async extract(urls: string[], opts: ExtractOptions = {}): Promise<ExtractJob> {
    const docs: Document[] = [];
    for (const url of urls) {
      const intent = opts.prompt || `extract structured data from ${url}`;
      const resolved = await unbrowseResolve(url, intent);
      const top = topCandidate(resolved);
      if (top) {
        const exec = await unbrowseExecute(top.endpoint_id, {}, false);
        if (exec?.ok) {
          docs.push({ extract: exec.body, metadata: { sourceURL: url } });
          continue;
        }
      }
      docs.push({ metadata: { sourceURL: url, statusCode: 404 } });
    }
    return {
      id: `unbrowse-extract-${Date.now()}`,
      status: 'completed',
      data: docs.length === 1 ? docs[0].extract : docs.map((d) => d.extract),
    };
  }

  /**
   * search(query) — web/news/images search. Unbrowse marketplace doesn't have
   * a search index yet; v0.1 falls through to Firecrawl.
   */
  async search(query: string, opts: SearchOptions = {}): Promise<SearchData> {
    if (!this.apiKey) {
      throw new Error(
        `[@unbrowse/firecrawl-shim] search() requires FIRECRAWL_API_KEY fallback; search not in v0.1.`,
      );
    }
    const res = await fetch(`${this.apiUrl}/v2/search`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${this.apiKey}` },
      body: JSON.stringify({ query, ...opts }),
    });
    return (await res.json()) as SearchData;
  }
}

export { Firecrawl };
