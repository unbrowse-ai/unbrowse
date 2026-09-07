/**
 * @unbrowse/openai-agents — Unbrowse tools for the OpenAI Agents SDK.
 *
 *   import { Agent } from '@openai/agents';
 *   import { unbrowseTools } from '@unbrowse/openai-agents';
 *
 *   const agent = new Agent({ name: 'web', tools: unbrowseTools });
 *
 * Three tools wrap Unbrowse's resolve+execute marketplace surface:
 *   - unbrowse_resolve { url, intent }  -> ranked API shortlist for an intent
 *   - unbrowse_execute { endpoint_id, params? } -> run a resolved endpoint
 *   - unbrowse_search  { query, url? }  -> resolve an intent and execute the top hit
 *
 * Each tool object matches the OpenAI Agents SDK runtime shape:
 *   { name, description, parameters (plain JSON Schema), execute(args) }
 * The SDK calls the handler `execute`; some surfaces call it `invoke`, so both
 * are provided. `execute` always resolves to a string (JSON.stringify of the
 * result), which is what the SDK feeds back into the model as the tool output.
 *
 * Backend mirrors the other @unbrowse shims: base from UNBROWSE_API_URL /
 * UNBROWSE_BASE / default. Set UNBROWSE_DRYRUN=1 for a deterministic, offline
 * synthesized result with no network call.
 */

const DEFAULT_BASE = 'https://beta-api.unbrowse.ai';

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

async function uExec(endpointId: string, params: Record<string, unknown> = {}): Promise<any> {
  try {
    const r = await fetch(`${unbrowseBase()}/v1/execute`, {
      method: 'POST',
      headers: auth(),
      body: JSON.stringify({ endpoint_id: endpointId, params, raw: true }),
      signal: AbortSignal.timeout(30000),
    });
    return await r.json();
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

function topId(resolved: any): string | null {
  const list = resolved?.available_operations || resolved?.available_endpoints || [];
  return list[0]?.endpoint_id ?? null;
}

function isDryRun(): boolean {
  return process.env.UNBROWSE_DRYRUN === '1';
}

/** OpenAI Agents SDK runtime tool shape. */
export interface UnbrowseTool {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
  execute: (args: any) => Promise<string>;
  /** Alias for execute — some SDK surfaces call the handler `invoke`. */
  invoke: (args: any) => Promise<string>;
}

function makeTool(
  name: string,
  description: string,
  parameters: Record<string, unknown>,
  run: (args: any) => Promise<unknown>,
): UnbrowseTool {
  const execute = async (args: any): Promise<string> => {
    const result = await run(args || {});
    return typeof result === 'string' ? result : JSON.stringify(result);
  };
  return { name, description, parameters, execute, invoke: execute };
}

// ---- unbrowse_resolve -------------------------------------------------------

export const unbrowseResolveTool = makeTool(
  'unbrowse_resolve',
  'Resolve an intent plus a URL into a ranked shortlist of cached Unbrowse API endpoints. Returns endpoint candidates (each with an endpoint_id) that can be run with unbrowse_execute.',
  {
    type: 'object',
    properties: {
      url: { type: 'string', description: 'The site or page URL to resolve against, e.g. https://example.com/products.' },
      intent: { type: 'string', description: 'Natural-language description of what you want, e.g. "list all products in stock".' },
    },
    required: ['url', 'intent'],
    additionalProperties: false,
  },
  async ({ url, intent }: { url: string; intent: string }) => {
    if (isDryRun()) {
      return {
        ok: true,
        dryrun: true,
        url,
        intent,
        available_operations: [
          { endpoint_id: `dryrun:${url}:${intent}`.slice(0, 120), score: 1, summary: `synthesized route for "${intent}"` },
        ],
      };
    }
    const resolved = await uResolve(url, intent);
    return resolved ?? { ok: false, error: 'no_cached_match', url, intent };
  },
);

// ---- unbrowse_execute -------------------------------------------------------

export const unbrowseExecuteTool = makeTool(
  'unbrowse_execute',
  'Execute a resolved Unbrowse endpoint by its endpoint_id (from unbrowse_resolve), optionally passing parameters. Returns the endpoint result body.',
  {
    type: 'object',
    properties: {
      endpoint_id: { type: 'string', description: 'The endpoint_id returned by unbrowse_resolve.' },
      params: { type: 'object', description: 'Optional key/value parameters to pass to the endpoint.', additionalProperties: true },
    },
    required: ['endpoint_id'],
    additionalProperties: false,
  },
  async ({ endpoint_id, params }: { endpoint_id: string; params?: Record<string, unknown> }) => {
    if (isDryRun()) {
      return { ok: true, dryrun: true, endpoint_id, params: params ?? {}, body: { synthesized: true } };
    }
    return await uExec(endpoint_id, params ?? {});
  },
);

// ---- unbrowse_search --------------------------------------------------------

export const unbrowseSearchTool = makeTool(
  'unbrowse_search',
  'One-shot search: resolve a query (optionally scoped to a URL) and execute the top-ranked endpoint, returning its result body. Use when you just want the answer without inspecting the shortlist first.',
  {
    type: 'object',
    properties: {
      query: { type: 'string', description: 'What you are looking for, in natural language.' },
      url: { type: 'string', description: 'Optional site/page URL to scope the search; omit to search broadly.' },
    },
    required: ['query'],
    additionalProperties: false,
  },
  async ({ query, url }: { query: string; url?: string }) => {
    const targetUrl = url || '';
    if (isDryRun()) {
      return {
        ok: true,
        dryrun: true,
        query,
        url: targetUrl,
        endpoint_id: `dryrun:search:${query}`.slice(0, 120),
        body: { synthesized: true, query },
      };
    }
    const resolved = await uResolve(targetUrl, query);
    const id = topId(resolved);
    if (!id) return { ok: false, error: 'no_cached_match', query, url: targetUrl };
    const exec = await uExec(id, {});
    return { ok: exec?.ok !== false, query, url: targetUrl, endpoint_id: id, body: exec?.body ?? exec };
  },
);

// ---- exports ----------------------------------------------------------------

/** All three Unbrowse tools as plain OpenAI Agents SDK runtime tool objects. */
export const unbrowseTools: UnbrowseTool[] = [
  unbrowseResolveTool,
  unbrowseExecuteTool,
  unbrowseSearchTool,
];

/**
 * Given the real `tool` factory from the OpenAI Agents SDK, return real tool
 * instances. Each plain tool object is passed straight through `tool()`:
 *
 *   import { tool } from '@openai/agents';
 *   import { createUnbrowseTools } from '@unbrowse/openai-agents';
 *   const tools = createUnbrowseTools({ tool });
 */
export function createUnbrowseTools({ tool }: { tool: (def: any) => any }): any[] {
  return unbrowseTools.map((t) => tool({ ...t }));
}

export default unbrowseTools;
