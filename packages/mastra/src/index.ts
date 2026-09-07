/**
 * @unbrowse/mastra — native Unbrowse tools for Mastra agents.
 *
 *   import { unbrowseTools } from '@unbrowse/mastra';
 *   import { Agent } from '@mastra/core/agent';
 *
 *   const agent = new Agent({
 *     name: 'web',
 *     instructions: 'Use Unbrowse to resolve, execute, and search the web.',
 *     model,
 *     tools: unbrowseTools,
 *   });
 *
 * Three tools — unbrowse_resolve, unbrowse_execute, unbrowse_search — backed by
 * Unbrowse's resolve+execute marketplace. inputSchema is plain JSON Schema (no
 * zod dependency). Each tool's execute() accepts either Mastra's `{ context }`
 * envelope or the args object directly, and reads `context` if present.
 *
 * `unbrowseTools` is a record of runtime-shaped tool definitions
 * (`{ id, description, inputSchema, execute }`) usable directly as Mastra tools.
 * `createUnbrowseTools({ createTool })` wraps each definition in Mastra's real
 * `createTool()` so they carry Mastra's branding/validation.
 *
 * Attribution: shaped for `@mastra/core` (https://github.com/mastra-ai/mastra,
 * Apache-2.0/Elastic). Semantics are Unbrowse's own routing layer.
 */

const DEFAULT_BASE = 'https://beta-api.unbrowse.ai';

// ── backend helpers (mirrors @unbrowse/got-shim style) ──────────────────────

function unbrowseBase(): string {
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
    const r = await fetch(`${unbrowseBase()}/v1/resolve`, {
      method: 'POST',
      headers: auth(),
      body: JSON.stringify({ url, intent }),
      signal: AbortSignal.timeout(8000),
    });
    return r.ok ? await r.json() : null;
  } catch {
    return null;
  }
}

async function uExec(endpointId: string, params: Record<string, unknown> = {}, raw = true): Promise<any> {
  try {
    const r = await fetch(`${unbrowseBase()}/v1/execute`, {
      method: 'POST',
      headers: auth(),
      body: JSON.stringify({ endpoint_id: endpointId, params, raw, extract: !raw }),
      signal: AbortSignal.timeout(30000),
    });
    return await r.json();
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

function candidates(resolved: any): Array<{ endpoint_id: string; [k: string]: unknown }> {
  return resolved?.available_operations || resolved?.available_endpoints || [];
}

function topId(resolved: any): string | null {
  return candidates(resolved)[0]?.endpoint_id ?? null;
}

const isDryrun = () => process.env.UNBROWSE_DRYRUN === '1';

/** Mastra passes args under `context`; support both `{context}` and the raw args. */
function readArgs<T extends Record<string, any>>(arg: any): T {
  if (arg && typeof arg === 'object' && 'context' in arg && arg.context && typeof arg.context === 'object') {
    return arg.context as T;
  }
  return (arg ?? {}) as T;
}

// ── tool definitions (runtime shape) ────────────────────────────────────────

export interface UnbrowseToolDef {
  id: string;
  description: string;
  inputSchema: Record<string, unknown>;
  outputSchema?: Record<string, unknown>;
  execute: (arg: any) => Promise<unknown>;
}

const objSchema = (
  properties: Record<string, unknown>,
  required: string[] = [],
): Record<string, unknown> => ({
  type: 'object',
  properties,
  required,
  additionalProperties: false,
});

export const unbrowse_resolve: UnbrowseToolDef = {
  id: 'unbrowse_resolve',
  description:
    'Resolve an intent + URL to a ranked shortlist of executable Unbrowse API endpoints. Call this first to discover which cached route can satisfy a goal, then pass the chosen endpoint_id to unbrowse_execute.',
  inputSchema: objSchema(
    {
      url: { type: 'string', description: 'The target URL or site the goal is about.' },
      intent: { type: 'string', description: 'Natural-language description of what you want to retrieve or do.' },
    },
    ['url', 'intent'],
  ),
  async execute(arg) {
    const { url, intent } = readArgs<{ url: string; intent: string }>(arg);
    if (isDryrun()) {
      return {
        ok: true,
        source: 'dryrun',
        url,
        intent,
        available_operations: [
          { endpoint_id: `dryrun:${url || 'resource'}`, intent, score: 1 },
        ],
      };
    }
    const resolved = await uResolve(url, intent);
    return resolved ?? { ok: false, available_operations: [], url, intent };
  },
};

export const unbrowse_execute: UnbrowseToolDef = {
  id: 'unbrowse_execute',
  description:
    'Execute a resolved Unbrowse endpoint by its endpoint_id (from unbrowse_resolve), with optional params. Returns the endpoint response body.',
  inputSchema: objSchema(
    {
      endpoint_id: { type: 'string', description: 'The endpoint_id returned by unbrowse_resolve.' },
      params: { type: 'object', description: 'Optional parameters to pass to the endpoint.', additionalProperties: true },
    },
    ['endpoint_id'],
  ),
  async execute(arg) {
    const { endpoint_id, params } = readArgs<{ endpoint_id: string; params?: Record<string, unknown> }>(arg);
    if (isDryrun()) {
      return { ok: true, source: 'dryrun', endpoint_id, params: params ?? {}, body: { endpoint_id, params: params ?? {} } };
    }
    return await uExec(endpoint_id, params ?? {}, true);
  },
};

export const unbrowse_search: UnbrowseToolDef = {
  id: 'unbrowse_search',
  description:
    'Search the web (optionally scoped to a URL/site) for information. Resolves the query against Unbrowse and executes the best-matching cached route, returning the result body.',
  inputSchema: objSchema(
    {
      query: { type: 'string', description: 'The search query / information goal.' },
      url: { type: 'string', description: 'Optional URL or site to scope the search to.' },
    },
    ['query'],
  ),
  async execute(arg) {
    const { query, url } = readArgs<{ query: string; url?: string }>(arg);
    const target = url || 'https://www.google.com/search';
    if (isDryrun()) {
      return {
        ok: true,
        source: 'dryrun',
        query,
        url: target,
        results: [{ title: `result for: ${query}`, url: target, snippet: query }],
      };
    }
    const resolved = await uResolve(target, query);
    const id = topId(resolved);
    if (!id) {
      return { ok: false, query, url: target, results: [], error: 'no_cached_match' };
    }
    const exec = await uExec(id, url ? {} : { q: query }, true);
    return { ok: exec?.ok !== false, query, url: target, endpoint_id: id, body: exec?.body ?? exec };
  },
};

/** Record keyed by tool id — usable directly as Mastra `tools`. */
export const unbrowseTools: Record<string, UnbrowseToolDef> = {
  unbrowse_resolve,
  unbrowse_execute,
  unbrowse_search,
};

// ── Mastra createTool() factory ──────────────────────────────────────────────

export interface CreateToolDeps {
  createTool: (def: {
    id: string;
    description: string;
    inputSchema: Record<string, unknown>;
    outputSchema?: Record<string, unknown>;
    execute: (arg: any) => Promise<unknown>;
  }) => unknown;
}

/**
 * Given Mastra's real `createTool` (from `@mastra/core/tools`), return a record
 * of real Mastra tools keyed by id. Pass the result to `new Agent({ tools })`.
 */
export function createUnbrowseTools({ createTool }: CreateToolDeps): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const def of Object.values(unbrowseTools)) {
    out[def.id] = createTool({
      id: def.id,
      description: def.description,
      inputSchema: def.inputSchema,
      execute: def.execute,
    });
  }
  return out;
}

export default unbrowseTools;
