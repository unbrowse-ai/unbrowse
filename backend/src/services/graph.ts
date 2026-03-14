import type { Env } from "../types.js";

const EMERGENTDB_BASE = "https://api.emergentdb.com";

async function edbRequest(
  env: Env,
  method: "GET" | "POST",
  path: string,
  body?: unknown
): Promise<unknown> {
  const res = await fetch(`${EMERGENTDB_BASE}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${env.EMERGENTDB_API_KEY}`,
      "Content-Type": "application/json",
      "Accept-Encoding": "identity",
      "User-Agent": "unbrowse/0.1.0",
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  const data = text ? JSON.parse(text) : {};
  if (!res.ok) throw new Error((data as { error?: string }).error ?? `EmergentDB HTTP ${res.status}`);
  return data;
}

function normalizeDomain(env: Env, domain: string): string {
  const clean = domain.replace(/^www\./, "");
  return env.ENVIRONMENT === "staging" ? `stg-${clean}` : clean;
}

export interface GraphEdge {
  to: string;
  binding: string;
}

export interface GraphNode {
  endpoint_id: string;
  requires?: string[];
  provides?: string[];
  action_kind?: string;
  resource_kind?: string;
  reliability_score?: number;
}

export interface SessionAction {
  intent: string;
  domain: string;
  endpoint_id: string;
  result: "success" | "failure" | "skip";
  timestamp?: number;
}

/** Upsert DAG edges for a node in a domain. */
export async function upsertEdges(
  env: Env,
  domain: string,
  node: GraphNode,
  edges: GraphEdge[]
): Promise<void> {
  await edbRequest(env, "POST", "/graph/edges", {
    domain: normalizeDomain(env, domain),
    node,
    edges,
  });
}

/** Resolve a prerequisite chain for a target endpoint. */
export async function resolveChain(
  env: Env,
  domain: string,
  targetEndpointId: string,
  availableBindings?: string[]
): Promise<unknown> {
  return edbRequest(env, "POST", "/graph/chain", {
    domain: normalizeDomain(env, domain),
    target_endpoint_id: targetEndpointId,
    available_bindings: availableBindings ?? [],
  });
}

/** Record an action in a session for co-occurrence learning. */
export async function recordSession(
  env: Env,
  sessionId: string,
  action: SessionAction
): Promise<void> {
  await edbRequest(env, "POST", "/graph/session", {
    session_id: sessionId,
    action,
  });
}

/** Get co-occurrence predictions from a starting node. */
export async function predictNext(
  env: Env,
  domain: string,
  fromId: string,
  k = 5
): Promise<unknown> {
  return edbRequest(
    env,
    "GET",
    `/graph/predict/${encodeURIComponent(normalizeDomain(env, domain))}?from=${encodeURIComponent(fromId)}&k=${k}`
  );
}

/** Record a negative example — intent that should NOT match an endpoint. */
export async function recordNegative(
  env: Env,
  domain: string,
  intentPattern: string,
  endpointId: string
): Promise<void> {
  await edbRequest(env, "POST", "/graph/negative", {
    domain: normalizeDomain(env, domain),
    intent_pattern: intentPattern,
    endpoint_id: endpointId,
  });
}

/** Check remaining Graph API credits. */
export async function checkCredits(env: Env): Promise<unknown> {
  return edbRequest(env, "GET", "/graph/credits");
}

/** Check cached intent→endpoint routing. */
export async function getIntentCache(env: Env, query: string, domain?: string): Promise<unknown> {
  const params = new URLSearchParams({ query });
  if (domain) params.set("domain", normalizeDomain(env, domain));
  return edbRequest(env, "GET", `/graph/intent-cache?${params}`);
}

/** Dump the co-occurrence matrix for a domain. */
export async function getCooccurrence(env: Env, domain: string): Promise<unknown> {
  return edbRequest(env, "GET", `/graph/cooccurrence/${encodeURIComponent(normalizeDomain(env, domain))}`);
}

/** Read adjacency list for a specific endpoint node. */
export async function getEdges(env: Env, domain: string, endpointId: string): Promise<unknown> {
  return edbRequest(
    env,
    "GET",
    `/graph/edges/${encodeURIComponent(normalizeDomain(env, domain))}/${encodeURIComponent(endpointId)}`
  );
}

/** Proxy pass-through to the dedicated bolt instance. */
export async function graphProxy(env: Env, subpath: string): Promise<unknown> {
  return edbRequest(env, "GET", `/graph/proxy/${subpath}`);
}
