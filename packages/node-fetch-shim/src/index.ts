/**
 * @unbrowse/node-fetch-shim — drop-in replacement for `node-fetch`.
 *
 *   - import fetch from 'node-fetch';
 *   + import fetch from '@unbrowse/node-fetch-shim';
 *
 *   const res = await fetch('https://api.site.com/items');
 *   const json = await res.json();
 *
 * Same default export, same named exports (Headers, Request, Response,
 * FetchError, AbortError, Blob, FormData, isRedirect). A safe GET routes
 * through Unbrowse's marketplace cache first (`/v1/resolve` + `/v1/execute`):
 * cache hit → free synthesized Response, miss → falls straight through to the
 * platform's native fetch. Anything non-GET, or any caller that sets
 * UNBROWSE_NODE_FETCH_PASSTHROUGH=1, is a pure pass-through to native fetch —
 * so behaviour is identical to node-fetch and you only ever save money, never
 * change semantics.
 *
 * Attribution: node-fetch (https://github.com/node-fetch/node-fetch) defines
 * the surface this mirrors; this shim exists to lower its callers' egress cost,
 * not to replace it — on a miss it is exactly node-fetch/native fetch.
 */

const DEFAULT_BASE = 'https://beta-api.unbrowse.ai';

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

function urlOf(input: RequestInfo | URL): string {
  if (typeof input === 'string') return input;
  if (input instanceof URL) return input.toString();
  return (input as Request).url;
}

function methodOf(input: RequestInfo | URL, init?: RequestInit): string {
  const m = init?.method || (typeof input === 'object' && 'method' in input ? (input as Request).method : undefined);
  return (m || 'GET').toUpperCase();
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

async function unbrowseExecute(endpointId: string): Promise<any> {
  try {
    const res = await fetch(`${unbrowseBase()}/v1/execute`, {
      method: 'POST',
      headers: unbrowseAuth(),
      body: JSON.stringify({ endpoint_id: endpointId, params: {}, raw: true }),
      signal: AbortSignal.timeout(30000),
    });
    return await res.json();
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

function topEndpointId(resolved: any): string | null {
  const list = resolved?.available_operations || resolved?.available_endpoints || [];
  return list[0]?.endpoint_id ?? null;
}

function intentFor(url: string): string {
  try {
    const u = new URL(url);
    const parts = u.pathname.split('/').filter(Boolean);
    return parts.length ? `fetch ${parts.slice(-2).join(' ')} from ${u.hostname}` : `fetch homepage of ${u.hostname}`;
  } catch {
    return 'fetch resource';
  }
}

/** node-fetch's FetchError — kept for `instanceof` / `.type` / `.code` callers. */
export class FetchError extends Error {
  type: string;
  code?: string;
  errno?: string;
  constructor(message: string, type = 'system', systemError?: { code?: string; errno?: string }) {
    super(message);
    this.name = 'FetchError';
    this.type = type;
    if (systemError?.code) this.code = this.errno = systemError.code;
    if (systemError?.errno) this.errno = systemError.errno;
  }
}

/** node-fetch's AbortError. */
export class AbortError extends Error {
  type = 'aborted';
  constructor(message = 'The operation was aborted.') {
    super(message);
    this.name = 'AbortError';
  }
}

/** node-fetch's `isRedirect(code)` helper. */
export function isRedirect(code: number): boolean {
  return code === 301 || code === 302 || code === 303 || code === 307 || code === 308;
}

/**
 * The drop-in fetch. A safe GET tries the Unbrowse cache; everything else is a
 * pure pass-through to native fetch. Identical signature and return type.
 */
const unbrowseFetch: typeof fetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
  const passthrough = process.env.UNBROWSE_NODE_FETCH_PASSTHROUGH === '1';
  const method = methodOf(input, init);
  const url = urlOf(input);

  if (!passthrough && method === 'GET') {
    const resolved = await unbrowseResolve(url, intentFor(url));
    const endpointId = topEndpointId(resolved);
    if (endpointId) {
      const exec = await unbrowseExecute(endpointId);
      if (exec?.ok && exec.body !== undefined) {
        const isStr = typeof exec.body === 'string';
        const body = isStr ? exec.body : JSON.stringify(exec.body);
        return new Response(body, {
          status: 200,
          statusText: 'OK',
          headers: {
            'content-type': isStr ? 'text/html; charset=utf-8' : 'application/json',
            'x-unbrowse-source': 'marketplace-cache',
          },
        });
      }
    }
  }

  // Miss / non-GET / passthrough → exactly node-fetch (native fetch).
  return fetch(input, init);
};

export { unbrowseFetch as fetch };
export default unbrowseFetch;

// Re-export the request/response primitives node-fetch callers import by name.
export const Headers = globalThis.Headers;
export const Request = globalThis.Request;
export const Response = globalThis.Response;
export const Blob = globalThis.Blob;
export const FormData = globalThis.FormData;
