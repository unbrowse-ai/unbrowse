/**
 * @unbrowse/langchain-js — Unbrowse as native LangChain JS tools.
 *
 *   import { unbrowseTools } from '@unbrowse/langchain-js';
 *   const agent = createReactAgent({ llm, tools: unbrowseTools });
 *
 * Three tools shaped exactly like LangChain's StructuredTool / DynamicStructuredTool
 * runtime surface — `{ name, description, schema (JSON Schema), invoke(input), call(input) }`:
 *
 *   - unbrowse_resolve { url, intent }            -> resolve an intent+URL to a ranked endpoint shortlist
 *   - unbrowse_execute { endpoint_id, params? }   -> execute a resolved endpoint
 *   - unbrowse_search  { query, url? }            -> resolve + execute synthesized into results
 *
 * `invoke` is the modern Runnable method; `call` is the legacy alias — both are provided
 * and both return a JSON string (LangChain tools return strings).
 *
 * `schema` is a plain JSON-Schema object so this package carries NO zod dependency. To get
 * branded DynamicStructuredTool instances, pass your own `@langchain/core` `tool` helper to
 * `createUnbrowseTools({ tool })`.
 *
 * Backend mirrors the other Unbrowse shims (resolve+execute over the marketplace cache).
 * Set UNBROWSE_DRYRUN=1 for a deterministic offline synthesized result (no network).
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

async function unbrowseExecute(
  endpointId: string,
  params: Record<string, unknown> = {},
  raw = true,
): Promise<any> {
  try {
    const res = await fetch(`${unbrowseBase()}/v1/execute`, {
      method: 'POST',
      headers: unbrowseAuth(),
      body: JSON.stringify({ endpoint_id: endpointId, params, raw, extract: !raw }),
      signal: AbortSignal.timeout(30000),
    });
    return await res.json();
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

function topCandidate(resolved: any): { endpoint_id: string } | null {
  const list = resolved?.available_operations || resolved?.available_endpoints || [];
  return list[0]?.endpoint_id ? { endpoint_id: list[0].endpoint_id } : null;
}

function dryrun(): boolean {
  return process.env.UNBROWSE_DRYRUN === '1';
}

// ---- tool implementations (return objects; invoke/call stringify) ---------

async function resolveImpl(input: { url: string; intent?: string }): Promise<unknown> {
  const url = input?.url ?? '';
  const intent = input?.intent ?? `resolve ${url}`;
  if (dryrun()) {
    return {
      ok: true,
      dryrun: true,
      url,
      intent,
      available_operations: [
        { endpoint_id: 'dryrun-endpoint-1', description: `synthesized route for: ${intent}` },
      ],
    };
  }
  const resolved = await unbrowseResolve(url, intent);
  if (!resolved) return { ok: false, url, intent, available_operations: [] };
  return resolved;
}

async function executeImpl(input: {
  endpoint_id: string;
  params?: Record<string, unknown>;
}): Promise<unknown> {
  const endpointId = input?.endpoint_id ?? '';
  const params = input?.params ?? {};
  if (dryrun()) {
    return {
      ok: true,
      dryrun: true,
      endpoint_id: endpointId,
      params,
      body: { result: `synthesized execution of ${endpointId}`, params },
    };
  }
  return await unbrowseExecute(endpointId, params, true);
}

async function searchImpl(input: { query: string; url?: string }): Promise<unknown> {
  const query = input?.query ?? '';
  const url = input?.url ?? '';
  if (dryrun()) {
    return {
      ok: true,
      dryrun: true,
      query,
      results: [
        {
          title: `synthesized result for: ${query}`,
          url: url || 'https://unbrowse.ai',
          snippet: `Offline dryrun synthesized passage for query "${query}".`,
        },
      ],
    };
  }
  const resolved = await unbrowseResolve(url || query, query);
  const top = topCandidate(resolved);
  if (!top) return { ok: false, query, results: [] };
  const exec = await unbrowseExecute(top.endpoint_id, {}, false);
  const body = exec?.body ?? exec;
  return {
    ok: !!exec?.ok,
    query,
    endpoint_id: top.endpoint_id,
    results: Array.isArray(body) ? body : [body],
  };
}

// ---- LangChain-shaped tool factory ----------------------------------------

export interface UnbrowseLangChainTool {
  name: string;
  description: string;
  schema: Record<string, unknown>;
  invoke(input: any): Promise<string>;
  call(input: any): Promise<string>;
}

function makeTool(
  name: string,
  description: string,
  schema: Record<string, unknown>,
  fn: (input: any) => Promise<unknown>,
): UnbrowseLangChainTool {
  const run = async (input: any): Promise<string> => {
    const result = await fn(input ?? {});
    return JSON.stringify(result);
  };
  return { name, description, schema, invoke: run, call: run };
}

const RESOLVE_SCHEMA = {
  type: 'object',
  properties: {
    url: { type: 'string', description: 'The website URL to resolve an endpoint for.' },
    intent: { type: 'string', description: 'Natural-language description of what you want to do.' },
  },
  required: ['url'],
} as const;

const EXECUTE_SCHEMA = {
  type: 'object',
  properties: {
    endpoint_id: { type: 'string', description: 'The endpoint_id returned by unbrowse_resolve.' },
    params: { type: 'object', description: 'Parameters to pass to the endpoint.' },
  },
  required: ['endpoint_id'],
} as const;

const SEARCH_SCHEMA = {
  type: 'object',
  properties: {
    query: { type: 'string', description: 'The search query.' },
    url: { type: 'string', description: 'Optional site URL to scope the search to.' },
  },
  required: ['query'],
} as const;

export const unbrowseResolveTool: UnbrowseLangChainTool = makeTool(
  'unbrowse_resolve',
  'Resolve an intent and URL to a ranked shortlist of executable API endpoints from the Unbrowse marketplace. Returns available_operations with endpoint_ids to pass to unbrowse_execute.',
  RESOLVE_SCHEMA as unknown as Record<string, unknown>,
  resolveImpl,
);

export const unbrowseExecuteTool: UnbrowseLangChainTool = makeTool(
  'unbrowse_execute',
  'Execute a resolved Unbrowse endpoint by its endpoint_id, optionally with params. Returns the endpoint response body.',
  EXECUTE_SCHEMA as unknown as Record<string, unknown>,
  executeImpl,
);

export const unbrowseSearchTool: UnbrowseLangChainTool = makeTool(
  'unbrowse_search',
  'Search the web via Unbrowse: resolves the query (optionally scoped to a url) to an endpoint, executes it, and synthesizes ranked results.',
  SEARCH_SCHEMA as unknown as Record<string, unknown>,
  searchImpl,
);

export const unbrowseTools: UnbrowseLangChainTool[] = [
  unbrowseResolveTool,
  unbrowseExecuteTool,
  unbrowseSearchTool,
];

/**
 * createUnbrowseTools({ tool }) — given LangChain's real `tool` helper
 * (from `@langchain/core/tools`), returns real DynamicStructuredTool instances
 * wrapping the same implementations. We do not import `@langchain/core` ourselves
 * (no dependency / no zod); you pass the helper you already have.
 *
 *   import { tool } from '@langchain/core/tools';
 *   import { createUnbrowseTools } from '@unbrowse/langchain-js';
 *   const tools = createUnbrowseTools({ tool });
 */
export function createUnbrowseTools({ tool }: { tool: (fn: any, config: any) => any }): any[] {
  const defs: {
    name: string;
    description: string;
    schema: Record<string, unknown>;
    fn: (input: any) => Promise<unknown>;
  }[] = [
    { name: 'unbrowse_resolve', description: unbrowseResolveTool.description, schema: RESOLVE_SCHEMA as any, fn: resolveImpl },
    { name: 'unbrowse_execute', description: unbrowseExecuteTool.description, schema: EXECUTE_SCHEMA as any, fn: executeImpl },
    { name: 'unbrowse_search', description: unbrowseSearchTool.description, schema: SEARCH_SCHEMA as any, fn: searchImpl },
  ];
  return defs.map((d) =>
    tool(
      async (input: any) => JSON.stringify(await d.fn(input ?? {})),
      { name: d.name, description: d.description, schema: d.schema },
    ),
  );
}
