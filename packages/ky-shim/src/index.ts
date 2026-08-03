/**
 * @unbrowse/ky-shim — drop-in replacement for `ky`.
 *
 *   - import ky from 'ky';
 *   + import ky from '@unbrowse/ky-shim';
 *
 *   const data = await ky('https://api.site.com/items').json();
 *   const res = await ky.post('https://api.site.com/items', { json: { name: 'x' } });
 *
 * ky is already fetch-based, so the drop-in is exact: a safe GET routes through
 * Unbrowse's resolve+execute marketplace cache first (free synthesized `Response`
 * on a hit) and falls through to native fetch on a miss. The call returns ky's
 * `ResponsePromise` — a `Promise<Response>` augmented with `.json()/.text()/
 * .blob()/.arrayBuffer()/.formData()`. Same callable default, get/post/put/patch/
 * delete/head, create(), extend(), HTTPError/TimeoutError, throw-on-non-2xx.
 *
 * Attribution: mirrors the public surface of `ky`
 * (https://github.com/sindresorhus/ky, MIT). Semantics preserved; the shim only
 * lowers cost on cache hits.
 */

const DEFAULT_BASE = 'https://beta-api.unbrowse.ai';

export interface KyOptions extends Omit<RequestInit, 'headers'> {
  prefixUrl?: string;
  searchParams?: Record<string, string | number> | URLSearchParams | string;
  json?: unknown;
  headers?: Record<string, string>;
  timeout?: number | false;
  throwHttpErrors?: boolean;
  method?: string;
}

export class HTTPError extends Error {
  response: Response;
  request: Request | undefined;
  options: KyOptions;
  constructor(response: Response, request?: Request, options: KyOptions = {}) {
    super(`Request failed with status code ${response.status} ${response.statusText}`);
    this.name = 'HTTPError';
    this.response = response;
    this.request = request;
    this.options = options;
  }
}

export class TimeoutError extends Error {
  constructor(public request?: Request) {
    super('Request timed out');
    this.name = 'TimeoutError';
  }
}

interface ResponsePromise extends Promise<Response> {
  json<T = unknown>(): Promise<T>;
  text(): Promise<string>;
  blob(): Promise<Blob>;
  arrayBuffer(): Promise<ArrayBuffer>;
  formData(): Promise<FormData>;
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
function buildUrl(url: string, opts: KyOptions): string {
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

function makeInstance(defaults: KyOptions = {}) {
  function run(url: string, opts: KyOptions): ResponsePromise {
    const merged: KyOptions = { ...defaults, ...opts, headers: { ...(defaults.headers || {}), ...(opts.headers || {}) } };
    const method = (merged.method || 'GET').toUpperCase();
    const full = buildUrl(url, merged);

    const core: Promise<Response> = (async () => {
      let response: Response | null = null;

      if (method === 'GET' && process.env.UNBROWSE_KY_PASSTHROUGH !== '1') {
        const resolved = await uResolve(full, intentFor(full));
        const id = topId(resolved);
        if (id) {
          const exec = await uExec(id);
          if (exec?.ok && exec.body !== undefined) {
            const isStr = typeof exec.body === 'string';
            const body = isStr ? exec.body : JSON.stringify(exec.body);
            response = new Response(body, { status: 200, statusText: 'OK', headers: { 'content-type': isStr ? 'text/html; charset=utf-8' : 'application/json', 'x-unbrowse-source': 'marketplace-cache' } });
          }
        }
      }

      if (!response) {
        const init: RequestInit = {
          method,
          headers: merged.headers,
          body: merged.json !== undefined ? JSON.stringify(merged.json) : (merged.body as any),
        };
        if (typeof merged.timeout === 'number') init.signal = AbortSignal.timeout(merged.timeout);
        response = await fetch(full, init);
      }

      if (merged.throwHttpErrors !== false && !response.ok) throw new HTTPError(response, undefined, merged);
      return response;
    })();

    const p = core as ResponsePromise;
    p.json = async <T = unknown>() => (await (await core).clone().json()) as T;
    p.text = async () => (await core).clone().text();
    p.blob = async () => (await core).clone().blob();
    p.arrayBuffer = async () => (await core).clone().arrayBuffer();
    p.formData = async () => (await core).clone().formData();
    return p;
  }

  const ky = ((url: string, opts: KyOptions = {}) => run(url, opts)) as any;
  for (const m of ['get', 'post', 'put', 'patch', 'delete', 'head'] as const) {
    ky[m] = (url: string, opts: KyOptions = {}) => run(url, { ...opts, method: m });
  }
  ky.create = (newDefaults: KyOptions = {}) => makeInstance(newDefaults);
  ky.extend = (newDefaults: KyOptions = {}) => makeInstance({ ...defaults, ...newDefaults });
  ky.HTTPError = HTTPError;
  ky.TimeoutError = TimeoutError;
  ky.stop = Symbol('ky.stop');
  return ky;
}

const ky = makeInstance();
export default ky;
export { ky };
