/**
 * @unbrowse/tavily-shim — drop-in replacement for `@tavily/core`.
 *
 *   - import { tavily } from '@tavily/core';
 *   + import { tavily } from '@unbrowse/tavily-shim';
 *
 *   const client = tavily({ apiKey: 'tvly-xxx' });
 *   const res = await client.search('who founded unbrowse');
 *
 * Four methods mirror the Tavily JS SDK: search, searchQNA (qnaSearch),
 * searchContext, extract. Each routes through Unbrowse's marketplace cache
 * first (`/v1/resolve` with the query as intent + `/v1/execute` on the top
 * candidate); falls back to Tavily's own API only if Unbrowse misses AND a
 * Tavily apiKey is present (factory arg or TAVILY_API_KEY), so cost-conscious
 * callers pay Tavily only on a miss but the contract surface stays identical.
 *
 * Honest scope:
 *   - search/searchQNA/searchContext synthesize results from the resolved
 *     top-candidate execute body when Unbrowse has the route.
 *   - extract(urls) routes each URL through resolve+execute and returns its
 *     raw content; misses land in failedResults.
 *   - When Unbrowse misses and no Tavily key is set, calls fall back to
 *     Tavily's public API; with neither, search returns an empty result set
 *     rather than throwing (mirrors Tavily returning zero hits).
 *   - UNBROWSE_DRYRUN=1 returns a deterministic empty result WITHOUT network.
 */

const DEFAULT_BASE = 'https://beta-api.unbrowse.ai';
const TAVILY_BASE = 'https://api.tavily.com';

export interface SearchResult {
  title: string;
  url: string;
  content: string;
  score: number;
  rawContent?: string;
}

export interface SearchResponse {
  query: string;
  results: SearchResult[];
  answer?: string;
  responseTime?: number;
  images?: Array<string | { url: string; description?: string }>;
}

export interface SearchOptions {
  searchDepth?: 'basic' | 'advanced';
  topic?: 'general' | 'news';
  days?: number;
  maxResults?: number;
  includeImages?: boolean;
  includeAnswer?: boolean;
  includeRawContent?: boolean;
  includeDomains?: string[];
  excludeDomains?: string[];
  [k: string]: unknown;
}

export interface ExtractResult {
  url: string;
  rawContent: string;
}

export interface ExtractResponse {
  results: ExtractResult[];
  failedResults: Array<{ url: string; error?: string }>;
}

export interface ExtractOptions {
  extractDepth?: 'basic' | 'advanced';
  includeImages?: boolean;
  [k: string]: unknown;
}

export interface TavilyClient {
  search(query: string, options?: SearchOptions): Promise<SearchResponse>;
  searchQNA(query: string, options?: SearchOptions): Promise<string>;
  qnaSearch(query: string, options?: SearchOptions): Promise<string>;
  searchContext(query: string, options?: SearchOptions): Promise<string>;
  extract(urls: string[], options?: ExtractOptions): Promise<ExtractResponse>;
}

export interface TavilyClientOptions {
  apiKey?: string;
}

function base(): string {
  return process.env.UNBROWSE_API_URL || process.env.UNBROWSE_BASE || DEFAULT_BASE;
}

function auth(): Record<string, string> {
  const h: Record<string, string> = { 'content-type': 'application/json' };
  if (process.env.UNBROWSE_API_KEY) h['authorization'] = `Bearer ${process.env.UNBROWSE_API_KEY}`;
  const x = process.env.UNBROWSE_X_PAYMENT || process.env.X_PAYMENT;
  if (x) h['x-payment'] = x;
  return h;
}

async function uResolve(url: string, intent: string): Promise<any | null> {
  try {
    const r = await fetch(`${base()}/v1/resolve`, {
      method: 'POST',
      headers: auth(),
      body: JSON.stringify({ url, intent }),
      signal: AbortSignal.timeout(8000),
    });
    return r.ok ? await r.json() : null;
  } catch {
    return null;
  }
}

async function uExec(id: string, raw = true): Promise<any> {
  try {
    const r = await fetch(`${base()}/v1/execute`, {
      method: 'POST',
      headers: auth(),
      body: JSON.stringify({ endpoint_id: id, params: {}, raw, extract: !raw }),
      signal: AbortSignal.timeout(30000),
    });
    return await r.json();
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

function candidates(resolved: any): Array<{ endpoint_id: string; url?: string; title?: string; description?: string }> {
  return resolved?.available_operations || resolved?.available_endpoints || [];
}

function bodyToText(body: unknown): string {
  if (typeof body === 'string') return body;
  if (body == null) return '';
  try {
    return JSON.stringify(body);
  } catch {
    return String(body);
  }
}

/** Synthesize Tavily-shaped results from the resolved candidate shortlist. */
async function synthSearch(query: string, opts: SearchOptions): Promise<SearchResponse> {
  const t0 = Date.now();
  const resolved = await uResolve(query, query);
  const list = candidates(resolved);
  if (!list.length) {
    return { query, results: [], responseTime: (Date.now() - t0) / 1000 };
  }
  const max = opts.maxResults ?? 5;
  const wantRaw = opts.includeRawContent === true;
  const results: SearchResult[] = [];
  for (let i = 0; i < Math.min(list.length, max); i++) {
    const cand = list[i];
    const exec = await uExec(cand.endpoint_id, true);
    const content = exec?.ok && exec.body !== undefined ? bodyToText(exec.body) : (cand.description || '');
    results.push({
      title: cand.title || cand.url || cand.endpoint_id,
      url: cand.url || '',
      content: content.slice(0, 2000),
      score: 1 - i * 0.1,
      ...(wantRaw ? { rawContent: content } : {}),
    });
  }
  const resp: SearchResponse = { query, results, responseTime: (Date.now() - t0) / 1000 };
  if (opts.includeAnswer && results[0]) resp.answer = results[0].content.slice(0, 500);
  return resp;
}

function makeClient(config: TavilyClientOptions = {}): TavilyClient {
  const apiKey = config.apiKey || process.env.TAVILY_API_KEY || '';

  async function tavilyFetch(path: string, payload: Record<string, unknown>): Promise<any> {
    const r = await fetch(`${TAVILY_BASE}${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${apiKey}` },
      body: JSON.stringify({ ...payload }),
    });
    return await r.json();
  }

  function normalizeTavily(query: string, raw: any): SearchResponse {
    const results: SearchResult[] = (raw?.results || []).map((r: any) => ({
      title: r.title ?? '',
      url: r.url ?? '',
      content: r.content ?? '',
      score: r.score ?? 0,
      rawContent: r.raw_content ?? r.rawContent,
    }));
    return {
      query,
      results,
      answer: raw?.answer,
      responseTime: raw?.response_time ?? raw?.responseTime,
      images: raw?.images,
    };
  }

  async function search(query: string, options: SearchOptions = {}): Promise<SearchResponse> {
    if (process.env.UNBROWSE_DRYRUN === '1') {
      return { query, results: [] };
    }
    const synth = await synthSearch(query, options);
    if (synth.results.length) return synth;
    // Miss → fall back to Tavily only if a key is present.
    if (!apiKey) {
      return synth; // honest empty result, no throw
    }
    const raw = await tavilyFetch('/search', {
      query,
      search_depth: options.searchDepth,
      topic: options.topic,
      days: options.days,
      max_results: options.maxResults,
      include_images: options.includeImages,
      include_answer: options.includeAnswer,
      include_raw_content: options.includeRawContent,
      include_domains: options.includeDomains,
      exclude_domains: options.excludeDomains,
    });
    return normalizeTavily(query, raw);
  }

  async function searchQNA(query: string, options: SearchOptions = {}): Promise<string> {
    const res = await search(query, { ...options, includeAnswer: true, searchDepth: options.searchDepth ?? 'advanced' });
    return res.answer ?? res.results[0]?.content ?? '';
  }

  async function searchContext(query: string, options: SearchOptions = {}): Promise<string> {
    const res = await search(query, options);
    return res.results.map((r) => r.content).filter(Boolean).join('\n\n');
  }

  async function extract(urls: string[], options: ExtractOptions = {}): Promise<ExtractResponse> {
    if (process.env.UNBROWSE_DRYRUN === '1') {
      return { results: [], failedResults: urls.map((url) => ({ url })) };
    }
    const results: ExtractResult[] = [];
    const failedResults: Array<{ url: string; error?: string }> = [];
    const missed: string[] = [];
    for (const url of urls) {
      const resolved = await uResolve(url, `extract content from ${url}`);
      const top = candidates(resolved)[0];
      if (top) {
        const exec = await uExec(top.endpoint_id, true);
        if (exec?.ok && exec.body !== undefined) {
          results.push({ url, rawContent: bodyToText(exec.body) });
          continue;
        }
      }
      missed.push(url);
    }
    if (missed.length && apiKey) {
      const raw = await tavilyFetch('/extract', { urls: missed, extract_depth: options.extractDepth });
      for (const r of raw?.results || []) {
        results.push({ url: r.url, rawContent: r.raw_content ?? r.rawContent ?? '' });
      }
      for (const f of raw?.failed_results || raw?.failedResults || []) {
        failedResults.push({ url: f.url, error: f.error });
      }
    } else {
      for (const url of missed) failedResults.push({ url });
    }
    return { results, failedResults };
  }

  return { search, searchQNA, qnaSearch: searchQNA, searchContext, extract };
}

/** Factory mirroring `@tavily/core`'s named export: `tavily({ apiKey })`. */
export function tavily(config: TavilyClientOptions = {}): TavilyClient {
  return makeClient(config);
}

export default { tavily };
