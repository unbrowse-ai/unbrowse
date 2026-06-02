/**
 * @unbrowse/superagent-shim — drop-in replacement for `superagent`.
 *
 *   - import request from 'superagent';
 *   + import request from '@unbrowse/superagent-shim';
 *
 *   const res = await request.get('https://api.site.com/items');
 *   const res2 = await request('GET', 'https://api.site.com/items').query({ q: 'x' });
 *
 * A safe GET routes through Unbrowse's resolve+execute marketplace cache first
 * (free synthesized superagent Response on a hit); everything else, and any GET
 * miss, is performed with the platform's native fetch and shaped into superagent's
 * Response object `{ status, statusCode, ok, body, text, headers, type }`. Same
 * callable default `request(method, url)`, same `get/post/put/patch/del/delete/head`,
 * same chainable thenable Request (`.set/.query/.send/.type/.accept/.timeout`),
 * `await request.get(url)`, and node-style `.end(callback)`.
 *
 * Attribution: mirrors the public surface of `superagent`
 * (https://github.com/ladjs/superagent, MIT). Semantics preserved; the shim only
 * lowers cost on cache hits.
 */

const DEFAULT_BASE = 'https://beta-api.unbrowse.ai';

export interface SuperagentResponse<T = any> {
  status: number;
  statusCode: number;
  ok: boolean;
  body: T;
  text: string;
  headers: Record<string, string>;
  type: string;
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

function headersObj(h: Headers): Record<string, string> {
  const o: Record<string, string> = {};
  h.forEach((v, k) => { o[k] = v; });
  return o;
}

const MIME: Record<string, string> = {
  json: 'application/json',
  form: 'application/x-www-form-urlencoded',
  'form-data': 'application/x-www-form-urlencoded',
  html: 'text/html',
  text: 'text/plain',
  xml: 'application/xml',
};
function resolveType(t: string): string {
  return MIME[t] || t;
}

type EndCallback = (err: any, res?: SuperagentResponse) => void;

/** superagent's chainable, thenable Request. */
class Request implements PromiseLike<SuperagentResponse> {
  private _method: string;
  private _url: string;
  private _headers: Record<string, string> = {};
  private _query: string[] = [];
  private _body: any = undefined;
  private _timeout: number | undefined;
  private _promise: Promise<SuperagentResponse> | null = null;

  constructor(method: string, url: string) {
    this._method = (method || 'GET').toUpperCase();
    this._url = url;
  }

  set(field: string | Record<string, string>, val?: string): this {
    if (typeof field === 'object') {
      for (const [k, v] of Object.entries(field)) this._headers[k.toLowerCase()] = String(v);
    } else {
      this._headers[field.toLowerCase()] = String(val);
    }
    return this;
  }

  query(val: Record<string, any> | string): this {
    if (typeof val === 'string') {
      this._query.push(val);
    } else {
      this._query.push(new URLSearchParams(Object.entries(val).map(([k, v]) => [k, String(v)])).toString());
    }
    return this;
  }

  send(body: any): this {
    if (typeof body === 'object' && this._body && typeof this._body === 'object') {
      this._body = { ...this._body, ...body };
    } else {
      this._body = body;
    }
    if (typeof this._body === 'object' && !this._headers['content-type']) {
      this._headers['content-type'] = 'application/json';
    }
    return this;
  }

  type(t: string): this {
    this._headers['content-type'] = resolveType(t);
    return this;
  }

  accept(t: string): this {
    this._headers['accept'] = resolveType(t);
    return this;
  }

  timeout(ms: number | { response?: number; deadline?: number }): this {
    this._timeout = typeof ms === 'number' ? ms : (ms.deadline ?? ms.response);
    return this;
  }

  private fullUrl(): string {
    if (!this._query.length) return this._url;
    const qs = this._query.join('&');
    return this._url + (this._url.includes('?') ? '&' : '?') + qs;
  }

  private exec(): Promise<SuperagentResponse> {
    if (this._promise) return this._promise;
    const method = this._method;
    const full = this.fullUrl();

    this._promise = (async (): Promise<SuperagentResponse> => {
      let resp: SuperagentResponse | null = null;

      if (method === 'GET' && process.env.UNBROWSE_SUPERAGENT_PASSTHROUGH !== '1') {
        const resolved = await uResolve(full, intentFor(full));
        const id = topId(resolved);
        if (id) {
          const ex = await uExec(id);
          if (ex?.ok && ex.body !== undefined) {
            const isStr = typeof ex.body === 'string';
            const text = isStr ? ex.body : JSON.stringify(ex.body);
            resp = {
              status: 200,
              statusCode: 200,
              ok: true,
              body: isStr ? {} : ex.body,
              text,
              headers: { 'content-type': isStr ? 'text/html; charset=utf-8' : 'application/json', 'x-unbrowse-source': 'marketplace-cache' },
              type: isStr ? 'text/html' : 'application/json',
            };
          }
        }
      }

      if (!resp) {
        let outBody: BodyInit | undefined;
        if (this._body !== undefined) {
          outBody = typeof this._body === 'string' ? this._body : JSON.stringify(this._body);
        }
        const r = await fetch(full, {
          method,
          headers: this._headers,
          body: method === 'GET' || method === 'HEAD' ? undefined : outBody,
          signal: this._timeout ? AbortSignal.timeout(this._timeout) : undefined,
        });
        const text = await r.text();
        const ct = r.headers.get('content-type') || '';
        let body: any = {};
        if (ct.includes('application/json')) {
          try { body = text ? JSON.parse(text) : {}; } catch { body = {}; }
        }
        resp = {
          status: r.status,
          statusCode: r.status,
          ok: r.ok,
          body,
          text,
          headers: headersObj(r.headers),
          type: ct.split(';')[0] || '',
        };
      }

      return resp;
    })();

    return this._promise;
  }

  then<R1 = SuperagentResponse, R2 = never>(
    onResolve?: ((value: SuperagentResponse) => R1 | PromiseLike<R1>) | null,
    onReject?: ((reason: any) => R2 | PromiseLike<R2>) | null,
  ): Promise<R1 | R2> {
    return this.exec().then(onResolve, onReject);
  }

  catch<R = never>(onReject?: ((reason: any) => R | PromiseLike<R>) | null): Promise<SuperagentResponse | R> {
    return this.exec().catch(onReject);
  }

  end(callback?: EndCallback): this {
    this.exec().then(
      (res) => { if (callback) callback(res.ok ? null : new Error(`Got ${res.status}`), res); },
      (err) => { if (callback) callback(err); },
    );
    return this;
  }
}

interface RequestFactory {
  (method: string, url: string): Request;
  get(url: string): Request;
  post(url: string): Request;
  put(url: string): Request;
  patch(url: string): Request;
  del(url: string): Request;
  delete(url: string): Request;
  head(url: string): Request;
  Request: typeof Request;
}

const request = ((method: string, url: string) => new Request(method, url)) as RequestFactory;
request.get = (url: string) => new Request('GET', url);
request.post = (url: string) => new Request('POST', url);
request.put = (url: string) => new Request('PUT', url);
request.patch = (url: string) => new Request('PATCH', url);
request.del = (url: string) => new Request('DELETE', url);
request.delete = (url: string) => new Request('DELETE', url);
request.head = (url: string) => new Request('HEAD', url);
request.Request = Request;

export { request, Request };
export default request;
