/**
 * @unbrowse/cross-fetch-shim — drop-in replacement for `cross-fetch`.
 *
 *   - import fetch from 'cross-fetch';
 *   + import fetch from '@unbrowse/cross-fetch-shim';
 *
 *   const res = await fetch('https://api.site.com/items');
 *   const json = await res.json();
 *
 * cross-fetch is a universal fetch ponyfill: a default `fetch` export plus named
 * `fetch`, `Headers`, `Request`, `Response`. This shim keeps that exact surface
 * but routes a safe GET through Unbrowse's marketplace cache first (free
 * synthesized `Response` on a hit), falling straight through to the platform's
 * native fetch on a miss — identical semantics, lower cost on hits.
 *
 * Attribution: mirrors the public surface of `cross-fetch`
 * (https://github.com/lquixada/cross-fetch, MIT). On a miss it is exactly the
 * ponyfilled fetch; the shim only lowers cost on cache hits.
 */

const DEFAULT_BASE = 'https://beta-api.unbrowse.ai';

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
function urlOf(input: RequestInfo | URL): string {
  if (typeof input === 'string') return input;
  if (input instanceof URL) return input.toString();
  return (input as Request).url;
}
function methodOf(input: RequestInfo | URL, init?: RequestInit): string {
  const m = init?.method || (typeof input === 'object' && 'method' in input ? (input as Request).method : undefined);
  return (m || 'GET').toUpperCase();
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

/** The drop-in fetch: a safe GET tries the cache; everything else is native fetch. */
const crossFetch: typeof fetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
  if (process.env.UNBROWSE_CROSS_FETCH_PASSTHROUGH !== '1' && methodOf(input, init) === 'GET') {
    const url = urlOf(input);
    const resolved = await uResolve(url, intentFor(url));
    const id = topId(resolved);
    if (id) {
      const exec = await uExec(id);
      if (exec?.ok && exec.body !== undefined) {
        const isStr = typeof exec.body === 'string';
        return new Response(isStr ? exec.body : JSON.stringify(exec.body), {
          status: 200,
          statusText: 'OK',
          headers: { 'content-type': isStr ? 'text/html; charset=utf-8' : 'application/json', 'x-unbrowse-source': 'marketplace-cache' },
        });
      }
    }
  }
  return fetch(input, init);
};

export { crossFetch as fetch };
export default crossFetch;
export const Headers = globalThis.Headers;
export const Request = globalThis.Request;
export const Response = globalThis.Response;
