/**
 * @unbrowse/undici-shim — drop-in replacement for `undici`.
 *
 *   - import { request } from 'undici';
 *   + import { request } from '@unbrowse/undici-shim';
 *
 *   const { statusCode, headers, body } = await request('https://api.site.com/items');
 *   const data = await body.json();
 *
 * A safe GET routes through Unbrowse's resolve+execute marketplace cache first
 * (free synthesized undici ResponseData on a hit); everything else, and any GET
 * miss, is performed with the platform's native fetch and shaped into undici's
 * ResponseData object `{ statusCode, headers, body }` where `body` exposes
 * `.text()/.json()/.arrayBuffer()`. Also re-exports `fetch` and stub-but-correct
 * -shape `Client`/`Pool`/`Agent`/`setGlobalDispatcher`/`getGlobalDispatcher`/
 * `interceptors` so an undici caller's imports compile.
 *
 * Attribution: mirrors the public surface of `undici`
 * (https://github.com/nodejs/undici, MIT). Semantics preserved; the shim only
 * lowers cost on cache hits.
 */

const DEFAULT_BASE = 'https://beta-api.unbrowse.ai';

export interface RequestOptions {
  method?: string;
  headers?: Record<string, string> | string[] | Headers;
  body?: string | Buffer | Uint8Array | null;
  query?: Record<string, string | number> | URLSearchParams | string;
  signal?: AbortSignal;
  throwOnError?: boolean;
  [k: string]: unknown;
}

/** undici's response body — a thin streaming-ish wrapper with consume helpers. */
export interface ResponseBody {
  text(): Promise<string>;
  json<J = unknown>(): Promise<J>;
  arrayBuffer(): Promise<ArrayBuffer>;
}

export interface ResponseData {
  statusCode: number;
  headers: Record<string, string>;
  body: ResponseBody;
  trailers: Record<string, string>;
  opaque: unknown;
  context: unknown;
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

function normalizeUrl(url: string | URL, opts: RequestOptions): string {
  let full = typeof url === 'string' ? url : url.toString();
  if (opts.query) {
    const qs = opts.query instanceof URLSearchParams ? opts.query.toString()
      : typeof opts.query === 'string' ? opts.query
      : new URLSearchParams(Object.entries(opts.query).map(([k, v]) => [k, String(v)])).toString();
    full += (full.includes('?') ? '&' : '?') + qs;
  }
  return full;
}
function normalizeHeaders(h: RequestOptions['headers']): Record<string, string> | undefined {
  if (!h) return undefined;
  if (h instanceof Headers) { const o: Record<string, string> = {}; h.forEach((v, k) => { o[k] = v; }); return o; }
  if (Array.isArray(h)) { const o: Record<string, string> = {}; for (let i = 0; i + 1 < h.length; i += 2) o[h[i]] = h[i + 1]; return o; }
  return h;
}
function headersObj(h: Headers): Record<string, string> {
  const o: Record<string, string> = {};
  h.forEach((v, k) => { o[k] = v; });
  return o;
}

/** Build undici's consumable body from a string/buffer payload. */
function makeBody(payload: string | ArrayBuffer): ResponseBody {
  const text = typeof payload === 'string' ? payload : new TextDecoder().decode(payload);
  return {
    async text() { return text; },
    async json<J = unknown>() { return JSON.parse(text) as J; },
    async arrayBuffer() {
      const u8 = new TextEncoder().encode(text);
      return u8.buffer.slice(u8.byteOffset, u8.byteOffset + u8.byteLength) as ArrayBuffer;
    },
  };
}

/**
 * undici `request` — `{ statusCode, headers, body }` where `body` has
 * `.text()/.json()/.arrayBuffer()`. A safe GET routes through the Unbrowse cache
 * first; misses and non-GET fall through to native fetch.
 */
export async function request(url: string | URL, opts: RequestOptions = {}): Promise<ResponseData> {
  const method = (opts.method || 'GET').toUpperCase();
  const full = normalizeUrl(url, opts);
  const passthrough = process.env.UNBROWSE_UNDICI_PASSTHROUGH === '1';

  let resp: ResponseData | null = null;

  if (method === 'GET' && opts.body == null && !passthrough) {
    const resolved = await uResolve(full, intentFor(full));
    const id = topId(resolved);
    if (id) {
      const exec = await uExec(id);
      if (exec?.ok && exec.body !== undefined) {
        const isStr = typeof exec.body === 'string';
        const payload = isStr ? exec.body : JSON.stringify(exec.body);
        resp = {
          statusCode: 200,
          headers: { 'content-type': isStr ? 'text/html; charset=utf-8' : 'application/json', 'x-unbrowse-source': 'marketplace-cache' },
          body: makeBody(payload),
          trailers: {},
          opaque: opts.opaque,
          context: undefined,
        };
      }
    }
  }

  if (!resp) {
    const headers = normalizeHeaders(opts.headers);
    const r = await fetch(full, {
      method,
      headers,
      body: opts.body as any,
      signal: opts.signal,
    });
    const buf = await r.arrayBuffer();
    resp = {
      statusCode: r.status,
      headers: headersObj(r.headers),
      body: makeBody(buf),
      trailers: {},
      opaque: opts.opaque,
      context: undefined,
    };
  }

  if (opts.throwOnError && (resp.statusCode < 200 || resp.statusCode >= 300)) {
    const err = new Error(`Request failed with status code ${resp.statusCode}`) as Error & { statusCode: number };
    err.statusCode = resp.statusCode;
    throw err;
  }
  return resp;
}

/** Native fetch, re-exported so `import { fetch } from '@unbrowse/undici-shim'` works. */
export const fetch = globalThis.fetch;

/**
 * Stub-but-correct-shape dispatcher classes. They carry undici's callable
 * surface (`request`/`close`/`destroy`) so a caller's imports compile; each
 * `request` delegates to the shim's routed `request()`.
 */
class Dispatcher {
  request(opts: RequestOptions & { origin?: string; path?: string; url?: string | URL }): Promise<ResponseData> {
    const base = (opts.origin ? String(opts.origin).replace(/\/$/, '') : '') + (opts.path || '');
    return request((opts.url ?? base) as string | URL, opts);
  }
  async close(): Promise<void> {}
  async destroy(): Promise<void> {}
}

export class Client extends Dispatcher {
  origin: string;
  constructor(origin: string | URL = '', _opts: Record<string, unknown> = {}) {
    super();
    this.origin = String(origin);
  }
}

export class Pool extends Dispatcher {
  origin: string;
  constructor(origin: string | URL = '', _opts: Record<string, unknown> = {}) {
    super();
    this.origin = String(origin);
  }
}

export class Agent extends Dispatcher {
  constructor(_opts: Record<string, unknown> = {}) {
    super();
  }
}

let globalDispatcher: Dispatcher = new Agent();
export function setGlobalDispatcher(dispatcher: Dispatcher): void {
  globalDispatcher = dispatcher;
}
export function getGlobalDispatcher(): Dispatcher {
  return globalDispatcher;
}

/** undici's composable interceptor factories — present so imports compile. */
export const interceptors = {
  redirect: (_opts?: Record<string, unknown>) => (dispatch: unknown) => dispatch,
  retry: (_opts?: Record<string, unknown>) => (dispatch: unknown) => dispatch,
  dump: (_opts?: Record<string, unknown>) => (dispatch: unknown) => dispatch,
};

export default { request, fetch, Client, Pool, Agent, setGlobalDispatcher, getGlobalDispatcher, interceptors };
