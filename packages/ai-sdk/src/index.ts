/**
 * @unbrowse/ai-sdk — Unbrowse capabilities as Vercel AI SDK (npm: `ai`) tools.
 *
 *   import { unbrowseTools } from '@unbrowse/ai-sdk';
 *   import { generateText } from 'ai';
 *
 *   const res = await generateText({
 *     model,
 *     prompt: 'Find the current price of BTC',
 *     tools: unbrowseTools,
 *   });
 *
 * The Vercel AI SDK `tool()` runtime shape is a plain object
 * `{ description, inputSchema, execute }`. (AI SDK v5/6 renamed `parameters`
 * to `inputSchema`.) These tools ship `inputSchema` as a plain JSON-Schema
 * object so there is NO zod dependency — they are valid tool definitions in the
 * AI SDK's shape, usable directly.
 *
 * For framework-branded instances (so the SDK's own validation/typing applies),
 * pass the real `tool` and `jsonSchema` helpers from `ai` into
 * `createUnbrowseTools({ tool, jsonSchema })`.
 *
 * Three tools:
 *   - unbrowse_resolve : intent + url  -> ranked endpoint shortlist (/v1/resolve)
 *   - unbrowse_execute : endpoint_id + params -> execution result (/v1/execute)
 *   - unbrowse_search  : query (+ optional url) -> resolve top + execute it
 *
 * Offline: set UNBROWSE_DRYRUN=1 and every execute returns a deterministic
 * synthesized stub WITHOUT any network call.
 */

const DEFAULT_BASE = 'https://beta-api.unbrowse.ai';

/** JSON-Schema object — deliberately structural, no zod. */
export interface JSONSchema {
  type: string;
  properties?: Record<string, unknown>;
  required?: string[];
  [k: string]: unknown;
}

/** The Vercel AI SDK tool() runtime shape. */
export interface AISDKTool<Args = any, Result = any> {
  description: string;
  inputSchema: JSONSchema;
  execute: (args: Args) => Promise<Result>;
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

async function uResolve(url: string, intent: string): Promise<any> {
  if (dryrun()) {
    return {
      ok: true,
      dryrun: true,
      url,
      intent,
      available_operations: [
        { endpoint_id: 'dryrun-endpoint-0', score: 1, summary: `synthesized route for "${intent}"` },
      ],
    };
  }
  try {
    const r = await fetch(`${unbrowseBase()}/v1/resolve`, {
      method: 'POST',
      headers: unbrowseAuth(),
      body: JSON.stringify({ url, intent }),
      signal: AbortSignal.timeout(8000),
    });
    if (!r.ok) return { ok: false, error: `resolve HTTP ${r.status}`, status: r.status };
    return await r.json();
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

async function uExec(endpointId: string, params: Record<string, unknown> = {}): Promise<any> {
  if (dryrun()) {
    return { ok: true, dryrun: true, endpoint_id: endpointId, params, body: { synthesized: true, endpoint_id: endpointId } };
  }
  try {
    const r = await fetch(`${unbrowseBase()}/v1/execute`, {
      method: 'POST',
      headers: unbrowseAuth(),
      body: JSON.stringify({ endpoint_id: endpointId, params, raw: true }),
      signal: AbortSignal.timeout(30000),
    });
    return await r.json();
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

function topEndpointId(resolved: any): string | null {
  const list = resolved?.available_operations || resolved?.available_endpoints || [];
  return list[0]?.endpoint_id ?? null;
}

// ---- execute fns (framework-independent) ----------------------------------

async function resolveExecute(args: { url: string; intent: string }): Promise<any> {
  const { url, intent } = args || ({} as any);
  const resolved = await uResolve(url, intent);
  const list = resolved?.available_operations || resolved?.available_endpoints || [];
  return { ok: resolved?.ok !== false, url, intent, endpoints: list, raw: resolved };
}

async function execExecute(args: { endpoint_id: string; params?: Record<string, unknown> }): Promise<any> {
  const { endpoint_id, params } = args || ({} as any);
  const result = await uExec(endpoint_id, params || {});
  return { ok: result?.ok !== false, endpoint_id, result };
}

async function searchExecute(args: { query: string; url?: string }): Promise<any> {
  const { query, url } = args || ({} as any);
  const resolved = await uResolve(url || '', query);
  const id = topEndpointId(resolved);
  const list = resolved?.available_operations || resolved?.available_endpoints || [];
  if (!id) {
    return { ok: false, query, results: [], endpoints: list, note: 'no_cached_match', raw: resolved };
  }
  const exec = await uExec(id, {});
  return {
    ok: exec?.ok !== false,
    query,
    endpoint_id: id,
    results: exec?.body ?? exec,
    endpoints: list,
    raw: { resolved, exec },
  };
}

// ---- tool definitions (plain AI SDK shape) --------------------------------

export const unbrowse_resolve: AISDKTool<{ url: string; intent: string }> = {
  description:
    'Resolve an intent (and optional URL) to a ranked shortlist of cached Unbrowse API endpoints. ' +
    'Returns the endpoints best matching the intent; pick one and call unbrowse_execute.',
  inputSchema: {
    type: 'object',
    properties: {
      url: { type: 'string', description: 'Target site or API URL (or hostname) to resolve against.' },
      intent: { type: 'string', description: 'Natural-language description of what to retrieve or do.' },
    },
    required: ['url', 'intent'],
    additionalProperties: false,
  },
  execute: resolveExecute,
};

export const unbrowse_execute: AISDKTool<{ endpoint_id: string; params?: Record<string, unknown> }> = {
  description:
    'Execute a resolved Unbrowse endpoint by its endpoint_id (from unbrowse_resolve) with optional params, ' +
    'returning the live result.',
  inputSchema: {
    type: 'object',
    properties: {
      endpoint_id: { type: 'string', description: 'The endpoint_id returned by unbrowse_resolve.' },
      params: { type: 'object', description: 'Optional parameters to pass to the endpoint.', additionalProperties: true },
    },
    required: ['endpoint_id'],
    additionalProperties: false,
  },
  execute: execExecute,
};

export const unbrowse_search: AISDKTool<{ query: string; url?: string }> = {
  description:
    'One-shot search: resolve the query as an intent, execute the top-ranked endpoint, and return synthesized results. ' +
    'Use when you just want an answer and do not need to inspect the endpoint shortlist first.',
  inputSchema: {
    type: 'object',
    properties: {
      query: { type: 'string', description: 'What to search for, in natural language.' },
      url: { type: 'string', description: 'Optional site/API URL to scope the search to.' },
    },
    required: ['query'],
    additionalProperties: false,
  },
  execute: searchExecute,
};

/** Record of Unbrowse tools in the Vercel AI SDK tool() runtime shape. */
export const unbrowseTools: Record<string, AISDKTool> = {
  unbrowse_resolve,
  unbrowse_execute,
  unbrowse_search,
};

/**
 * Factory: given the caller's real AI SDK `tool` and `jsonSchema` helpers,
 * return framework-branded tool objects wrapping the same execute fns. This is
 * the genuine drop-in path when `ai` is installed:
 *
 *   import { tool, jsonSchema } from 'ai';
 *   import { createUnbrowseTools } from '@unbrowse/ai-sdk';
 *   const tools = createUnbrowseTools({ tool, jsonSchema });
 */
export function createUnbrowseTools(deps: {
  tool: (def: any) => any;
  jsonSchema: (schema: any) => any;
}): Record<string, any> {
  const { tool, jsonSchema } = deps || ({} as any);
  if (typeof tool !== 'function' || typeof jsonSchema !== 'function') {
    throw new Error('[@unbrowse/ai-sdk] createUnbrowseTools requires { tool, jsonSchema } from the AI SDK (npm: ai).');
  }
  const out: Record<string, any> = {};
  for (const [name, def] of Object.entries(unbrowseTools)) {
    out[name] = tool({
      description: def.description,
      inputSchema: jsonSchema(def.inputSchema),
      execute: def.execute,
    });
  }
  return out;
}

export default unbrowseTools;
