/**
 * Thin wrapper around the Unbrowse public API used by the shim's goto path.
 * Calls /v1/resolve to look up a cached endpoint matching the URL+intent,
 * and /v1/execute to retrieve the actual data. Does NOT depend on the SDK
 * runtime — keeps the shim's install footprint tiny — but the SDK is
 * declared as a dependency so callers who want the full SDK shape can also
 * use it directly.
 *
 * Auth model: API key OR x402 envelope, both pulled from env. The shim is
 * pointer-only on the client side — no business logic, just translation.
 */

const DEFAULT_BASE = 'https://beta-api.unbrowse.ai';

export interface ResolveCandidate {
  endpoint_id: string;
  url_template: string;
  method: string;
  score: number;
  response_schema?: unknown;
  sample_values?: Record<string, unknown>;
  requires?: string[];
  yields?: string[];
}

export interface ResolveResult {
  status: 'ok' | 'no_cached_match' | 'browse_session_open' | 'auth_required';
  available_operations?: ResolveCandidate[];
  available_endpoints?: ResolveCandidate[];
  next_step?: string;
  session_id?: string;
}

export interface ExecuteResult {
  ok: boolean;
  status_code?: number;
  body?: unknown;
  headers?: Record<string, string>;
  error?: string;
  source?: string;
}

function getBase(): string {
  return process.env.UNBROWSE_API_URL || process.env.UNBROWSE_BASE || DEFAULT_BASE;
}

function authHeaders(): Record<string, string> {
  const h: Record<string, string> = { 'content-type': 'application/json' };
  const apiKey = process.env.UNBROWSE_API_KEY;
  if (apiKey) h['authorization'] = `Bearer ${apiKey}`;
  const x402 = process.env.UNBROWSE_X_PAYMENT || process.env.X_PAYMENT;
  if (x402) h['x-payment'] = x402;
  return h;
}

/**
 * resolve(url, intent) — ask Unbrowse if there's a cached/published API route
 * that matches the user's URL+intent. Returns a ranked shortlist of candidates;
 * shim picks the top one for the cache-hit synthesis. Cache miss → null.
 */
export async function resolve(url: string, intent: string): Promise<ResolveResult | null> {
  const base = getBase();
  try {
    const res = await fetch(`${base}/v1/resolve`, {
      method: 'POST',
      headers: authHeaders(),
      body: JSON.stringify({ url, intent }),
      signal: AbortSignal.timeout(8000),
    });
    if (!res.ok) return null;
    return (await res.json()) as ResolveResult;
  } catch {
    return null;
  }
}

/**
 * execute(endpointId, params, raw=true) — call the chosen endpoint. raw mode
 * returns the body bytes/string as-is so the shim can hand them to the caller
 * as if they came from a real page.goto().
 */
export async function execute(
  endpointId: string,
  params: Record<string, unknown> = {},
  opts: { raw?: boolean; extract?: boolean } = {},
): Promise<ExecuteResult> {
  const base = getBase();
  try {
    const res = await fetch(`${base}/v1/execute`, {
      method: 'POST',
      headers: authHeaders(),
      body: JSON.stringify({
        endpoint_id: endpointId,
        params,
        raw: opts.raw ?? true,
        extract: opts.extract ?? false,
      }),
      signal: AbortSignal.timeout(30000),
    });
    const body = await res.json().catch(() => null);
    return body as ExecuteResult;
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}
