/**
 * @unbrowse/wretch-shim — drop-in replacement for `wretch`.
 *
 *   - import wretch from 'wretch';
 *   + import wretch from '@unbrowse/wretch-shim';
 *
 *   const data = await wretch('https://api.site.com/items').get().json();
 *   await wretch('https://api.site.com').post({ name: 'x' }, '/items').res();
 *
 * A safe GET routes through Unbrowse's resolve+execute marketplace cache first
 * (free synthesized response on a hit); everything else, and any GET miss, is
 * performed with the platform's native fetch. The returned value mirrors wretch's
 * chainable instance: the `url/headers/auth/content/query/options/accept` config
 * chain, the `json/body/formData` body setters, the `get/post/put/patch/delete/
 * head` verbs that fire the request, and a thenable ResponseChain whose
 * `json()/text()/res()/arrayBuffer()` resolve the body and whose `notFound()/
 * error()` register status catchers.
 *
 * Attribution: mirrors the public surface of `wretch`
 * (https://github.com/elbywan/wretch, MIT). Semantics preserved; the shim only
 * lowers cost on cache hits.
 */

const DEFAULT_BASE = 'https://beta-api.unbrowse.ai';

export interface WretchConfig {
  url: string;
  headers: Record<string, string>;
  options: Record<string, unknown>;
  query: string;
  body?: BodyInit | null;
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

function fullUrl(cfg: WretchConfig): string {
  return cfg.query ? cfg.url + (cfg.url.includes('?') ? '&' : '?') + cfg.query : cfg.url;
}
function headersObj(h: Headers): Record<string, string> {
  const o: Record<string, string> = {};
  h.forEach((v, k) => { o[k] = v; });
  return o;
}

/** A native Response or a synthesized cache-hit stand-in. */
interface ShimResponse {
  status: number;
  statusText: string;
  ok: boolean;
  headers: Record<string, string>;
  url: string;
  text(): Promise<string>;
  json(): Promise<any>;
  arrayBuffer(): Promise<ArrayBuffer>;
}

function synthResponse(body: unknown, url: string): ShimResponse {
  const isStr = typeof body === 'string';
  const text = isStr ? (body as string) : JSON.stringify(body);
  return {
    status: 200,
    statusText: 'OK',
    ok: true,
    headers: { 'content-type': isStr ? 'text/html; charset=utf-8' : 'application/json', 'x-unbrowse-source': 'marketplace-cache' },
    url,
    text: async () => text,
    json: async () => (isStr ? JSON.parse(text) : body),
    arrayBuffer: async () => new TextEncoder().encode(text).buffer,
  };
}
function wrapResponse(r: Response, url: string): ShimResponse {
  return {
    status: r.status,
    statusText: r.statusText,
    ok: r.ok,
    headers: headersObj(r.headers),
    url,
    text: () => r.text(),
    json: () => r.json(),
    arrayBuffer: () => r.arrayBuffer(),
  };
}

type Catcher = (resp: ShimResponse) => unknown;

/** wretch's ResponseChain: thenable, with json/text/res/arrayBuffer + status catchers. */
class ResponseChain {
  private core: Promise<ShimResponse>;
  private catchers = new Map<number, Catcher>();

  constructor(produce: () => Promise<ShimResponse>) {
    this.core = produce();
  }

  private async settled(): Promise<ShimResponse> {
    const resp = await this.core;
    if (!resp.ok) {
      const cb = this.catchers.get(resp.status);
      if (cb) { await cb(resp); }
    }
    return resp;
  }

  notFound(cb: Catcher): this { this.catchers.set(404, cb); return this; }
  error(code: number, cb: Catcher): this { this.catchers.set(code, cb); return this; }

  json<T = any>(cb?: (data: T) => unknown): Promise<T> {
    return this.settled().then(async (r) => {
      const data = (await r.json()) as T;
      return (cb ? (cb(data) as T) : data);
    });
  }
  text(cb?: (data: string) => unknown): Promise<string> {
    return this.settled().then(async (r) => {
      const data = await r.text();
      return (cb ? (cb(data) as string) : data);
    });
  }
  res(cb?: (resp: ShimResponse) => unknown): Promise<ShimResponse> {
    return this.settled().then((r) => (cb ? (cb(r) as ShimResponse) : r));
  }
  arrayBuffer(cb?: (data: ArrayBuffer) => unknown): Promise<ArrayBuffer> {
    return this.settled().then(async (r) => {
      const data = await r.arrayBuffer();
      return (cb ? (cb(data) as ArrayBuffer) : data);
    });
  }

  // Thenable: `await wretch(...).get()` resolves to the response.
  then<TResult1 = ShimResponse, TResult2 = never>(
    onfulfilled?: ((value: ShimResponse) => TResult1 | PromiseLike<TResult1>) | null,
    onrejected?: ((reason: any) => TResult2 | PromiseLike<TResult2>) | null,
  ): Promise<TResult1 | TResult2> {
    return this.settled().then(onfulfilled, onrejected);
  }
  catch<T = never>(onrejected?: ((reason: any) => T | PromiseLike<T>) | null): Promise<ShimResponse | T> {
    return this.settled().catch(onrejected);
  }
}

class Wretch {
  private cfg: WretchConfig;

  constructor(cfg: WretchConfig) {
    this.cfg = cfg;
  }

  private clone(patch: Partial<WretchConfig>): Wretch {
    return new Wretch({ ...this.cfg, ...patch, headers: { ...this.cfg.headers, ...(patch.headers || {}) }, options: { ...this.cfg.options, ...(patch.options || {}) } });
  }

  // --- config chain ---
  url(url: string, replace = false): Wretch {
    return this.clone({ url: replace ? url : this.cfg.url + url });
  }
  headers(obj: Record<string, string>): Wretch { return this.clone({ headers: obj }); }
  auth(val: string): Wretch { return this.clone({ headers: { authorization: val } }); }
  content(type: string): Wretch { return this.clone({ headers: { 'content-type': type } }); }
  accept(type: string): Wretch { return this.clone({ headers: { accept: type } }); }
  options(obj: Record<string, unknown>): Wretch { return this.clone({ options: obj }); }
  query(obj: Record<string, string | number | boolean>): Wretch {
    const qs = new URLSearchParams(Object.entries(obj).map(([k, v]) => [k, String(v)])).toString();
    return this.clone({ query: this.cfg.query ? this.cfg.query + '&' + qs : qs });
  }

  // --- body setters / resolver overload (json) ---
  // wretch: `.json()` / `.json(fn)` on a ResponseChain resolves; `.json(obj)` on a
  // Wretch sets the request body. Here, called on a Wretch: undefined/function is a
  // no-op resolver passthrough, an object sets the JSON body.
  json(arg?: unknown): Wretch {
    if (arg === undefined || typeof arg === 'function') return this;
    return this.clone({ body: JSON.stringify(arg), headers: { 'content-type': 'application/json' } });
  }
  body(data: BodyInit): Wretch { return this.clone({ body: data }); }
  formData(obj: Record<string, unknown>): Wretch {
    const fd = new FormData();
    for (const [k, v] of Object.entries(obj)) fd.append(k, v as any);
    return this.clone({ body: fd as any });
  }

  // --- HTTP verbs (fire the request, return a ResponseChain) ---
  private fire(method: string, url?: string): ResponseChain {
    const cfg: WretchConfig = url ? { ...this.cfg, url: this.cfg.url + url } : this.cfg;
    const full = fullUrl(cfg);
    const m = method.toUpperCase();
    return new ResponseChain(async () => {
      if (m === 'GET' && process.env.UNBROWSE_WRETCH_PASSTHROUGH !== '1') {
        const resolved = await uResolve(full, intentFor(full));
        const id = topId(resolved);
        if (id) {
          const exec = await uExec(id);
          if (exec?.ok && exec.body !== undefined) return synthResponse(exec.body, full);
        }
      }
      const r = await fetch(full, {
        method: m,
        headers: cfg.headers,
        body: m === 'GET' || m === 'HEAD' ? undefined : (cfg.body as any),
        ...(cfg.options as RequestInit),
      });
      return wrapResponse(r, full);
    });
  }

  get(url?: string): ResponseChain { return this.fire('GET', url); }
  post(body?: unknown, url?: string): ResponseChain {
    const w = body !== undefined ? this.json(body) : this;
    return w.fire('POST', url);
  }
  put(body?: unknown, url?: string): ResponseChain {
    const w = body !== undefined ? this.json(body) : this;
    return w.fire('PUT', url);
  }
  patch(body?: unknown, url?: string): ResponseChain {
    const w = body !== undefined ? this.json(body) : this;
    return w.fire('PATCH', url);
  }
  delete(url?: string): ResponseChain { return this.fire('DELETE', url); }
  head(url?: string): ResponseChain { return this.fire('HEAD', url); }
}

function wretch(url = '', opts: Record<string, unknown> = {}): Wretch {
  return new Wretch({ url, headers: {}, options: opts, query: '' });
}

export { Wretch, ResponseChain };
export default wretch;
export { wretch };
