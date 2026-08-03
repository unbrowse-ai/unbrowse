/**
 * @unbrowse/llamaindex — Unbrowse as native LlamaIndex TS tools.
 *
 *   import { unbrowseTools } from '@unbrowse/llamaindex';
 *   import { agent } from '@llamaindex/workflow';
 *
 *   const myAgent = agent({ tools: unbrowseTools });
 *
 * Exposes three FunctionTool-shaped tools that an LlamaIndex agent can call:
 *   - unbrowse_resolve {url,intent}  — rank API endpoints for an intent+URL
 *   - unbrowse_execute {endpoint_id, params?} — run a resolved endpoint
 *   - unbrowse_search  {query, url?} — resolve+execute the top endpoint for a query
 *
 * Each tool routes through Unbrowse's resolve+execute marketplace cache
 * (`/v1/resolve` + `/v1/execute`). The runtime FunctionTool shape is a plain
 * object `{ metadata: { name, description, parameters }, call }` where
 * `parameters` is a JSON Schema object (no zod dependency) and `call` returns a
 * string (JSON.stringify of the result), which is what an LLM tool loop expects.
 *
 * Use `createUnbrowseTools({ FunctionTool })` to get real LlamaIndex
 * FunctionTool instances built via `FunctionTool.from(fn, metadata)`.
 *
 * Attribution: targets the public tool surface of LlamaIndex TS
 * (https://github.com/run-llama/LlamaIndexTS, MIT).
 */

const DEFAULT_BASE = 'https://beta-api.unbrowse.ai';

export interface JSONSchema {
  type: 'object';
  properties: Record<string, unknown>;
  required?: string[];
  [k: string]: unknown;
}

/** Runtime FunctionTool shape, no LlamaIndex dependency. */
export interface UnbrowseTool {
  metadata: {
    name: string;
    description: string;
    parameters: JSONSchema;
  };
  call: (input: any) => Promise<string>;
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

function dryrun(): boolean {
  return process.env.UNBROWSE_DRYRUN === '1';
}

async function unbrowseResolve(url: string, intent: string): Promise<any> {
  if (dryrun()) {
    return {
      ok: true,
      dryrun: true,
      url,
      intent,
      available_operations: [
        { endpoint_id: 'dryrun-endpoint-0', method: 'GET', score: 1, summary: `synthesized route for ${intent}` },
      ],
    };
  }
  try {
    const res = await fetch(`${unbrowseBase()}/v1/resolve`, {
      method: 'POST',
      headers: unbrowseAuth(),
      body: JSON.stringify({ url, intent }),
      signal: AbortSignal.timeout(8000),
    });
    if (!res.ok) return { ok: false, status: res.status, error: `resolve returned ${res.status}` };
    return await res.json();
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

async function unbrowseExecute(endpointId: string, params: Record<string, unknown> = {}): Promise<any> {
  if (dryrun()) {
    return { ok: true, dryrun: true, endpoint_id: endpointId, params, body: { result: `synthesized execution of ${endpointId}` } };
  }
  try {
    const res = await fetch(`${unbrowseBase()}/v1/execute`, {
      method: 'POST',
      headers: unbrowseAuth(),
      body: JSON.stringify({ endpoint_id: endpointId, params, raw: true }),
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

// --- Tool definitions (runtime FunctionTool shape) ---

export const unbrowseResolveTool: UnbrowseTool = {
  metadata: {
    name: 'unbrowse_resolve',
    description:
      'Resolve a user intent plus a target URL into a ranked shortlist of callable API endpoints from Unbrowse\'s route marketplace. Call this first to discover which endpoint can satisfy a data-retrieval intent, then pass the chosen endpoint_id to unbrowse_execute.',
    parameters: {
      type: 'object',
      properties: {
        url: { type: 'string', description: 'The target site or page URL to resolve against, e.g. https://example.com/products' },
        intent: { type: 'string', description: 'Plain-language description of what data you want, e.g. "list trending products"' },
      },
      required: ['url', 'intent'],
    },
  },
  call: async (input: { url: string; intent: string }) => {
    const resolved = await unbrowseResolve(input?.url, input?.intent);
    return JSON.stringify(resolved);
  },
};

export const unbrowseExecuteTool: UnbrowseTool = {
  metadata: {
    name: 'unbrowse_execute',
    description:
      'Execute a resolved Unbrowse endpoint by its endpoint_id (obtained from unbrowse_resolve) with optional parameters, returning the live API response body.',
    parameters: {
      type: 'object',
      properties: {
        endpoint_id: { type: 'string', description: 'The endpoint_id returned by unbrowse_resolve' },
        params: { type: 'object', description: 'Optional key/value parameters to pass to the endpoint', additionalProperties: true },
      },
      required: ['endpoint_id'],
    },
  },
  call: async (input: { endpoint_id: string; params?: Record<string, unknown> }) => {
    const exec = await unbrowseExecute(input?.endpoint_id, input?.params || {});
    return JSON.stringify(exec);
  },
};

export const unbrowseSearchTool: UnbrowseTool = {
  metadata: {
    name: 'unbrowse_search',
    description:
      'One-shot retrieval: resolve a query (optionally scoped to a URL) and execute the top-ranked endpoint, returning the fetched data. Use this when you want data for a query without manually picking an endpoint.',
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'What to search for / retrieve' },
        url: { type: 'string', description: 'Optional URL to scope the search to a specific site' },
      },
      required: ['query'],
    },
  },
  call: async (input: { query: string; url?: string }) => {
    const query = input?.query ?? '';
    const url = input?.url || 'https://www.google.com/search?q=' + encodeURIComponent(query);
    const resolved = await unbrowseResolve(url, query);
    const id = topEndpointId(resolved);
    if (!id) {
      return JSON.stringify({ ok: false, query, url, resolved, error: 'no endpoint resolved for query' });
    }
    const exec = await unbrowseExecute(id, {});
    return JSON.stringify({ ok: exec?.ok !== false, query, url, endpoint_id: id, result: exec });
  },
};

/** Array of the three runtime FunctionTool-shaped Unbrowse tools. */
export const unbrowseTools: UnbrowseTool[] = [unbrowseResolveTool, unbrowseExecuteTool, unbrowseSearchTool];

/**
 * Factory: given LlamaIndex's real `FunctionTool`, returns real FunctionTool
 * instances built via `FunctionTool.from(fn, metadata)`. Keeps the package free
 * of a hard `llamaindex` dependency — the caller injects the class they have.
 */
export function createUnbrowseTools({ FunctionTool }: { FunctionTool: { from: (fn: any, metadata: any) => any } }): any[] {
  return unbrowseTools.map((t) => FunctionTool.from(t.call, t.metadata));
}

export default unbrowseTools;
