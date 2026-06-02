/**
 * @unbrowse/exa-shim — drop-in replacement for `exa-js`.
 *
 *   - import Exa from 'exa-js';
 *   + import Exa from '@unbrowse/exa-shim';
 *
 *   const exa = new Exa('exa-xxx');
 *   const { results } = await exa.search('latest research on LLM agents');
 *   const { results } = await exa.searchAndContents('...', { numResults: 5 });
 *
 * The Exa surface mirrored here: search, searchAndContents, getContents,
 * findSimilar, findSimilarAndContents, answer. Each routes through Unbrowse's
 * resolved-route cache first (`/v1/resolve` with the query as intent +
 * `/v1/execute` on the top candidate). On a miss the shim falls back to Exa's
 * own API only if an Exa apiKey was provided (constructor arg or EXA_API_KEY),
 * so cost-conscious callers pay Exa only when Unbrowse misses, but the contract
 * surface stays identical.
 *
 * Honest scope:
 *   - search/searchAndContents route through resolve+execute, synthesizing
 *     SearchResult records from whatever the cached endpoint returned.
 *   - getContents resolves+executes per id/url to fill `text`.
 *   - findSimilar/findSimilarAndContents use the url as the resolve intent.
 *   - answer composes a search and stitches a synthesized answer + citations;
 *     a real generative answer requires the Exa fallback key.
 *   - UNBROWSE_DRYRUN=1 returns deterministic empty results with NO network,
 *     for tests.
 *
 * Attribution: mirrors the public surface of `exa-js`
 * (https://github.com/exa-labs/exa-js, MIT). Semantics preserved; the shim only
 * lowers cost on cache hits.
 */

const DEFAULT_BASE = 'https://beta-api.unbrowse.ai';
const EXA_BASE = 'https://api.exa.ai';

export type SearchType = 'neural' | 'keyword' | 'auto';

export interface ContentsOptions {
  text?: boolean | { maxCharacters?: number; includeHtmlTags?: boolean };
  highlights?: boolean | { numSentences?: number; highlightsPerUrl?: number; query?: string };
  summary?: boolean | { query?: string };
}

export interface SearchOptions extends ContentsOptions {
  numResults?: number;
  type?: SearchType;
  useAutoprompt?: boolean;
  category?: string;
  includeDomains?: string[];
  excludeDomains?: string[];
  startCrawlDate?: string;
  endCrawlDate?: string;
  startPublishedDate?: string;
  endPublishedDate?: string;
  includeText?: string[];
  excludeText?: string[];
}

export interface FindSimilarOptions extends SearchOptions {
  excludeSourceDomain?: boolean;
}

export interface AnswerOptions {
  text?: boolean;
  model?: string;
  systemPrompt?: string;
}

export interface SearchResult {
  id: string;
  url: string;
  title: string;
  score?: number;
  publishedDate?: string;
  author?: string;
  text?: string;
  highlights?: string[];
  highlightScores?: number[];
  summary?: string;
}

export interface SearchResponse {
  results: SearchResult[];
  autopromptString?: string;
  requestId?: string;
}

export interface GetContentsResponse {
  results: SearchResult[];
  requestId?: string;
}

export interface AnswerCitation {
  id: string;
  url: string;
  title: string;
  publishedDate?: string;
  author?: string;
  text?: string;
}

export interface AnswerResponse {
  answer: string;
  citations: AnswerCitation[];
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

async function unbrowseExecute(endpointId: string, params: Record<string, unknown> = {}, raw = false): Promise<any> {
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

/** A query has no single URL; synthesize a search-engine URL so resolve has a target. */
function searchUrlFor(query: string): string {
  return `https://www.google.com/search?q=${encodeURIComponent(query)}`;
}

function asString(v: unknown): string {
  if (v == null) return '';
  return typeof v === 'string' ? v : String(v);
}

/**
 * Coerce whatever the cached endpoint returned (array of records, object with
 * a `results`/`items`/`data` array, or a single record) into Exa SearchResults.
 */
function bodyToResults(body: any, opts: ContentsOptions = {}): SearchResult[] {
  let rows: any[] = [];
  if (Array.isArray(body)) rows = body;
  else if (Array.isArray(body?.results)) rows = body.results;
  else if (Array.isArray(body?.items)) rows = body.items;
  else if (Array.isArray(body?.data)) rows = body.data;
  else if (body && typeof body === 'object') rows = [body];

  const wantText = opts.text === undefined ? false : !!opts.text;
  const wantHighlights = !!opts.highlights;
  const wantSummary = !!opts.summary;

  return rows.map((r, i) => {
    const url = asString(r?.url || r?.link || r?.href || r?.id || '');
    const result: SearchResult = {
      id: asString(r?.id || url || `result-${i}`),
      url,
      title: asString(r?.title || r?.name || r?.headline || ''),
    };
    if (typeof r?.score === 'number') result.score = r.score;
    if (r?.publishedDate || r?.published_date || r?.date) {
      result.publishedDate = asString(r.publishedDate || r.published_date || r.date);
    }
    if (r?.author || r?.byline) result.author = asString(r.author || r.byline);
    if (wantText) result.text = asString(r?.text || r?.content || r?.markdown || r?.snippet || '');
    if (wantHighlights) {
      const hl = r?.highlights || r?.snippets;
      result.highlights = Array.isArray(hl) ? hl.map(asString) : hl ? [asString(hl)] : [];
    }
    if (wantSummary) result.summary = asString(r?.summary || r?.description || '');
    return result;
  });
}

function exaHeaders(apiKey: string): Record<string, string> {
  return { 'content-type': 'application/json', 'x-api-key': apiKey };
}

export class Exa {
  private apiKey: string;
  private baseURL: string;

  constructor(apiKey?: string, baseURL?: string) {
    this.apiKey = apiKey || process.env.EXA_API_KEY || '';
    this.baseURL = baseURL || EXA_BASE;
  }

  private dryrun(): boolean {
    return process.env.UNBROWSE_DRYRUN === '1';
  }

  /** search(query) — top results for a query. Cache hit → synthesized results. */
  async search(query: string, options: SearchOptions = {}): Promise<SearchResponse> {
    if (this.dryrun()) return { results: [], autopromptString: query };

    const resolved = await unbrowseResolve(searchUrlFor(query), query);
    const top = topCandidate(resolved);
    if (top) {
      const exec = await unbrowseExecute(top.endpoint_id, { q: query }, false);
      if (exec?.ok && exec.body !== undefined) {
        const results = bodyToResults(exec.body, options).slice(0, options.numResults ?? 10);
        return { results, autopromptString: options.useAutoprompt ? query : undefined };
      }
    }
    return this.exaSearch('/search', query, options);
  }

  /** searchAndContents(query) — search with page contents (text/highlights/summary). */
  async searchAndContents(query: string, options: SearchOptions = {}): Promise<SearchResponse> {
    const withContents: SearchOptions = { text: true, ...options };
    if (this.dryrun()) return { results: [], autopromptString: query };

    const resolved = await unbrowseResolve(searchUrlFor(query), query);
    const top = topCandidate(resolved);
    if (top) {
      const exec = await unbrowseExecute(top.endpoint_id, { q: query }, false);
      if (exec?.ok && exec.body !== undefined) {
        const results = bodyToResults(exec.body, withContents).slice(0, options.numResults ?? 10);
        return { results, autopromptString: options.useAutoprompt ? query : undefined };
      }
    }
    return this.exaSearch('/search', query, { ...withContents, _contents: true } as SearchOptions);
  }

  /** getContents(ids) — fetch text/contents for a set of urls or ids. */
  async getContents(ids: string[] | string, options: ContentsOptions = {}): Promise<GetContentsResponse> {
    const idList = Array.isArray(ids) ? ids : [ids];
    if (this.dryrun()) return { results: [] };

    const wantContents: ContentsOptions = { text: true, ...options };
    const results: SearchResult[] = [];
    let allMissed = true;
    for (const id of idList) {
      const url = /^https?:\/\//i.test(id) ? id : id;
      const resolved = await unbrowseResolve(url, `get contents of ${url}`);
      const top = topCandidate(resolved);
      if (top) {
        const exec = await unbrowseExecute(top.endpoint_id, {}, false);
        if (exec?.ok && exec.body !== undefined) {
          allMissed = false;
          const rows = bodyToResults(exec.body, wantContents);
          if (rows.length) {
            const row = rows[0];
            if (!row.url) row.url = url;
            if (!row.id) row.id = id;
            results.push(row);
            continue;
          }
        }
      }
      results.push({ id, url, title: '', text: '' });
    }
    if (allMissed && this.apiKey) {
      return this.exaContents(idList, wantContents);
    }
    return { results };
  }

  /** findSimilar(url) — results similar to a source url. */
  async findSimilar(url: string, options: FindSimilarOptions = {}): Promise<SearchResponse> {
    if (this.dryrun()) return { results: [] };

    const resolved = await unbrowseResolve(url, `find pages similar to ${url}`);
    const top = topCandidate(resolved);
    if (top) {
      const exec = await unbrowseExecute(top.endpoint_id, { url }, false);
      if (exec?.ok && exec.body !== undefined) {
        const results = bodyToResults(exec.body, options).slice(0, options.numResults ?? 10);
        return { results };
      }
    }
    return this.exaFindSimilar(url, options);
  }

  /** findSimilarAndContents(url) — similar results with page contents. */
  async findSimilarAndContents(url: string, options: FindSimilarOptions = {}): Promise<SearchResponse> {
    return this.findSimilar(url, { text: true, ...options });
  }

  /** answer(query) — a synthesized answer with supporting citations. */
  async answer(query: string, options: AnswerOptions = {}): Promise<AnswerResponse> {
    if (this.dryrun()) return { answer: '', citations: [] };

    // Try the Unbrowse-backed search to build citations + a stitched answer.
    const search = await this.searchAndContents(query, { numResults: 5, text: true });
    if (search.results.length) {
      const citations: AnswerCitation[] = search.results.map((r) => ({
        id: r.id,
        url: r.url,
        title: r.title,
        publishedDate: r.publishedDate,
        author: r.author,
        text: r.text,
      }));
      const stitched = search.results
        .map((r) => r.summary || r.text)
        .filter(Boolean)
        .join('\n\n')
        .slice(0, 4000);
      if (stitched) return { answer: stitched, citations };
    }
    // Real generative answer needs Exa's own endpoint.
    return this.exaAnswer(query, options);
  }

  // ── Exa fallback (only when an Exa apiKey was provided) ──────────────────

  private requireKey(method: string): void {
    if (!this.apiKey) {
      throw new Error(
        `[@unbrowse/exa-shim] no cached route for ${method}() and no EXA_API_KEY for fallback. ` +
          `Pass apiKey to the constructor or set EXA_API_KEY env to enable the Exa fallback.`,
      );
    }
  }

  private async exaSearch(path: string, query: string, options: SearchOptions): Promise<SearchResponse> {
    this.requireKey('search');
    const { _contents, ...rest } = options as SearchOptions & { _contents?: boolean };
    const body: Record<string, unknown> = { query, ...rest };
    if (_contents || rest.text || rest.highlights || rest.summary) {
      body.contents = {
        text: rest.text ?? true,
        highlights: rest.highlights,
        summary: rest.summary,
      };
    }
    const res = await fetch(`${this.baseURL}${path}`, {
      method: 'POST',
      headers: exaHeaders(this.apiKey),
      body: JSON.stringify(body),
    });
    const data = (await res.json()) as SearchResponse;
    return { results: data.results || [], autopromptString: data.autopromptString };
  }

  private async exaContents(ids: string[], options: ContentsOptions): Promise<GetContentsResponse> {
    this.requireKey('getContents');
    const res = await fetch(`${this.baseURL}/contents`, {
      method: 'POST',
      headers: exaHeaders(this.apiKey),
      body: JSON.stringify({ ids, text: options.text ?? true, highlights: options.highlights, summary: options.summary }),
    });
    const data = (await res.json()) as GetContentsResponse;
    return { results: data.results || [] };
  }

  private async exaFindSimilar(url: string, options: FindSimilarOptions): Promise<SearchResponse> {
    this.requireKey('findSimilar');
    const body: Record<string, unknown> = { url, ...options };
    if (options.text || options.highlights || options.summary) {
      body.contents = { text: options.text ?? true, highlights: options.highlights, summary: options.summary };
    }
    const res = await fetch(`${this.baseURL}/findSimilar`, {
      method: 'POST',
      headers: exaHeaders(this.apiKey),
      body: JSON.stringify(body),
    });
    const data = (await res.json()) as SearchResponse;
    return { results: data.results || [], autopromptString: data.autopromptString };
  }

  private async exaAnswer(query: string, options: AnswerOptions): Promise<AnswerResponse> {
    this.requireKey('answer');
    const res = await fetch(`${this.baseURL}/answer`, {
      method: 'POST',
      headers: exaHeaders(this.apiKey),
      body: JSON.stringify({ query, text: options.text, model: options.model, systemPrompt: options.systemPrompt }),
    });
    const data = (await res.json()) as AnswerResponse;
    return { answer: data.answer || '', citations: data.citations || [] };
  }
}

export default Exa;
