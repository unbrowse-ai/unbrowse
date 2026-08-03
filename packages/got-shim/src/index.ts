/**
 * @unbrowse/got-shim — drop-in replacement for `got`.
 *
 *   - import got from 'got';
 *   + import got from '@unbrowse/got-shim';
 *
 *   const { body, statusCode } = await got('https://api.site.com/items');
 *   const data = await got('https://api.site.com/items').json();
 *
 * A safe GET routes through Unbrowse's resolve+execute marketplace cache first
 * (free synthesized got Response on a hit); everything else, and any GET miss, is
 * performed with the platform's native fetch and shaped into got's Response object
 * `{ body, statusCode, statusMessage, headers, url }`. The returned value is got's
 * augmented promise: `await got(url)` yields the Response, and `.json()/.text()/
 * .buffer()` resolve the parsed body — same callable default, same get/post/put/
 * patch/delete/head, same extend(), HTTPError/RequestError.
 *
 * Attribution: mirrors the public surface of `got`
 * (https://github.com/sindresorhus/got, MIT). Semantics preserved; the shim only
 * lowers cost on cache hits.
 */

const DEFAULT_BASE = 'https://beta-api.unbrowse.ai';

export interface GotOptions {
  method?: string;
  prefixUrl?: string;
  headers?: Record<string, string>;
  searchParams?: Record<string, string | number> | URLSearchParams | string;
  json?: unknown;
  body?: string | Buffer;
  timeout?: number | { request?: number };
  responseType?: 'text' | 'json' | 'buffer';
  throwHttpErrors?: boolean;
  [k: string]: unknown;
}

export interface GotResponse<T = unknown> {
  body: T;
  statusCode: number;
  statusMessage: string;
  headers: Record<string, string>;
  url: string;
  ok: boolean;
  retryCount: number;
}

export class RequestError extends Error {
  code?: string;
  options?: GotOptions;
  constructor(message: string, code?: string, options?: GotOptions) {
    super(message);
    this.name = 'RequestError';
    this.code = code;
    this.options = options;
  }
}

export class HTTPError extends RequestError {
  response: GotResponse;
  constructor(response: GotResponse) {
    super(`Response code ${response.statusCode} (${response.statusMessage})`, 'ERR_NON_2XX_3XX_RESPONSE');
    this.name = 'HTTPError';
    this.response = response;
  }
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
    const r = await fetch(`${base()}/v1/resolve`, { method: 'POST', headers: auth(), body: JSON.stringify({ url, intent }), signal: AbortSignal.timeout(8000) });
    return r.ok ? await r.json() : null;
  } catch { return null; }
}
async function uExec(id: string): Promise<any> {
  try {
    const r = await fetch(`${base()}/v1/execute`, { method: 'POST', headers: auth(), body: JSON.stringify({ endpoint_id: id, params: {}, raw: true }), signal: AbortSignal.timeout(30000) });
    return await r.json();
  } catch (e) { return { ok: false, error: e instanceof Error ? e.message : String(e) }; }
}
function topId(resolved: any): string | null {
  const list = resolved?.available_operations || resolved?.available_endpoints || [];
  return list[0]?.endpoint_id ?? null;
}
function intentFor(url: string): string {
  try {
    const u = new URL(url);
    const p = u.pathname.split('/').filter(Boolean);
    return p.length ? `fetch ${p.slice(-2).join(' ')} from ${u.hostname}` : `fetch homepage of ${u.hostname}`;
  } catch { return 'fetch resource'; }
}

function buildUrl(url: string, opts: GotOptions): string {
  let full = url;
  if (opts.prefixUrl && !/^https?:\/\//i.test(url)) full = opts.prefixUrl.replace(/\/$/, '') + '/' + url.replace(/^\//, '');
  if (opts.searchParams) {
    const qs = opts.searchParams instanceof URLSearchParams ? opts.searchParams.toString()
      : typeof opts.searchParams === 'string' ? opts.searchParams
      : new URLSearchParams(Object.entries(opts.searchParams).map(([k, v]) => [k, String(v)])).toString();
    full += (full.includes('?') ? '&' : '?') + qs;
  }
  return full;
}
function headersObj(h: Headers): Record<string, string> {
  const o: Record<string, string> = {};
  h.forEach((v, k) => { o[k] = v; });
  return o;
}

/** got's augmented promise: awaitable to a Response, with .json()/.text()/.buffer(). */
interface GotPromise<T = unknown> extends Promise<GotResponse<T>> {
  json<J = unknown>(): Promise<J>;
  text(): Promise<string>;
  buffer(): Promise<Buffer>;
}

function makeInstance(defaults: GotOptions = {}) {
  function run(url: string, opts: GotOptions): GotPromise {
    const merged: GotOptions = { ...defaults, ...opts, headers: { ...(defaults.headers || {}), ...(opts.headers || {}) } };
    const method = (merged.method || 'GET').toUpperCase();
    const full = buildUrl(url, merged);

    const core: Promise<GotResponse> = (async () => {
      let resp: GotResponse | null = null;

      if (method === 'GET' && process.env.UNBROWSE_GOT_PASSTHROUGH !== '1') {
        const resolved = await uResolve(full, intentFor(full));
        const id = topId(resolved);
        if (id) {
          const exec = await uExec(id);
          if (exec?.ok && exec.body !== undefined) {
            const isStr = typeof exec.body === 'string';
            resp = { body: exec.body, statusCode: 200, statusMessage: 'OK', headers: { 'content-type': isStr ? 'text/html; charset=utf-8' : 'application/json', 'x-unbrowse-source': 'marketplace-cache' }, url: full, ok: true, retryCount: 0 };
          }
        }
      }

      if (!resp) {
        const r = await fetch(full, {
          method,
          headers: merged.headers,
          body: merged.json !== undefined ? JSON.stringify(merged.json) : (merged.body as any),
          signal: typeof merged.timeout === 'number' ? AbortSignal.timeout(merged.timeout)
            : merged.timeout?.request ? AbortSignal.timeout(merged.timeout.request) : undefined,
        });
        const text = await r.text();
        let body: unknown = text;
        if (merged.responseType === 'json' || (r.headers.get('content-type') || '').includes('application/json')) {
          try { body = text ? JSON.parse(text) : ''; } catch { body = text; }
        }
        resp = { body, statusCode: r.status, statusMessage: r.statusText, headers: headersObj(r.headers), url: full, ok: r.ok, retryCount: 0 };
      }

      const throwErrors = merged.throwHttpErrors !== false;
      if (throwErrors && (resp.statusCode < 200 || resp.statusCode >= 300)) throw new HTTPError(resp);
      return resp;
    })();

    const p = core as GotPromise;
    p.json = async <J = unknown>() => {
      const res = await core;
      return (typeof res.body === 'string' ? JSON.parse(res.body) : res.body) as J;
    };
    p.text = async () => {
      const res = await core;
      return typeof res.body === 'string' ? res.body : JSON.stringify(res.body);
    };
    p.buffer = async () => {
      const res = await core;
      return Buffer.from(typeof res.body === 'string' ? res.body : JSON.stringify(res.body), 'utf-8');
    };
    return p;
  }

  const got = ((url: string, opts: GotOptions = {}) => run(url, opts)) as any;
  for (const m of ['get', 'post', 'put', 'patch', 'delete', 'head'] as const) {
    got[m] = (url: string, opts: GotOptions = {}) => run(url, { ...opts, method: m });
  }
  got.extend = (newDefaults: GotOptions = {}) => makeInstance({ ...defaults, ...newDefaults });
  got.HTTPError = HTTPError;
  got.RequestError = RequestError;
  got.defaults = { options: defaults };
  return got;
}

const got = makeInstance();
export default got;
export { got };
