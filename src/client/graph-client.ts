import { DEFAULT_BACKEND_URL } from "../version.js";
import { getApiKey } from "./index.js";

const API_URL = process.env.UNBROWSE_BACKEND_URL ?? DEFAULT_BACKEND_URL;
const GRAPH_TIMEOUT_MS = parseInt(process.env.UNBROWSE_GRAPH_TIMEOUT_MS ?? "4000", 10);

async function graphApi<T>(method: string, path: string, body?: unknown): Promise<T> {
  const key = getApiKey();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), GRAPH_TIMEOUT_MS);
  let res: Response;
  try {
    res = await fetch(`${API_URL}${path}`, {
      method,
      headers: {
        "Content-Type": "application/json",
        "Accept-Encoding": "gzip, deflate",
        ...(key ? { Authorization: `Bearer ${key}` } : {}),
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
      signal: controller.signal,
    });
  } finally {
    clearTimeout(timer);
  }
  if (!res.ok) throw new Error(`graph API ${res.status} from ${path}`);
  return res.json() as Promise<T>;
}

export interface GraphChainLink {
  endpoint_id: string;
  requires?: string[];
  provides?: string[];
}

export interface GraphChainResult {
  chain: GraphChainLink[];
  resolved: boolean;
}

export interface GraphPrediction {
  endpoint_id: string;
  score: number;
}

/** POST /v1/graph/chain — resolve prerequisite chain for a target endpoint */
export async function fetchChain(
  domain: string,
  targetEndpointId: string,
  availableBindings?: string[],
): Promise<GraphChainResult> {
  return graphApi<GraphChainResult>("POST", "/v1/graph/chain", {
    domain,
    target_endpoint_id: targetEndpointId,
    available_bindings: availableBindings,
  });
}

/** GET /v1/graph/predict/:domain — co-occurrence predictions from a starting node */
export async function fetchPredictions(
  domain: string,
  fromId: string,
  k = 5,
): Promise<GraphPrediction[]> {
  const qs = `from=${encodeURIComponent(fromId)}&k=${k}`;
  return graphApi<GraphPrediction[]>("GET", `/v1/graph/predict/${encodeURIComponent(domain)}?${qs}`);
}

/** POST /v1/graph/session — report a session action (fire-and-forget) */
export async function recordSession(
  domain: string,
  sessionId: string,
  endpointId: string,
  intent: string,
  result: "success" | "failure" | "skip",
): Promise<void> {
  await graphApi<unknown>("POST", "/v1/graph/session", {
    session_id: sessionId,
    action: {
      intent,
      domain,
      endpoint_id: endpointId,
      result,
      timestamp: new Date().toISOString(),
    },
  });
}

/** POST /v1/graph/negative: report an explicit negative signal (fire-and-forget) */
export async function recordNegative(
  domain: string,
  intentPattern: string,
  endpointId: string,
): Promise<void> {
  await graphApi<unknown>("POST", "/v1/graph/negative", {
    domain,
    intent_pattern: intentPattern,
    endpoint_id: endpointId,
  });
}

/**
 * A sanitized per-execution edge outcome sent UP to the server-authoritative
 * confidence store. No payloads, no auth context, no secrets; just which
 * graph edge a real execution traversed and whether it worked. `weight > 1`
 * marks a stronger negative (e.g. a judge-rejected result).
 */
export interface EdgeOutcomeSignal {
  edge_id: string;
  succeeded: boolean;
  weight?: number;
}

/**
 * the root signature-user projection returned by the server. `confidences` maps
 * `edge_id -> server-authoritative confidence`; `observations` maps
 * `edge_id -> total cross-user observations` (evidence depth). The learning
 * math and the per-edge counters never cross this boundary.
 */
export interface EdgeConfidenceProjection {
  ok?: boolean;
  confidences: Record<string, number>;
  observations: Record<string, number>;
}

/**
 * In-process cache of the LAST server projection per domain. The client is
 * NOT authoritative. It only remembers what the server most recently
 * returned so the synchronous resolve path can overlay it without blocking
 * on the network. A forked client still only ever holds the projected
 * numbers the server chose to send, never the per-edge counters or the
 * learning math.
 */
const _projectionCache = new Map<string, Record<string, number>>();

/** Normalize a domain the same way the server does for the cache key. */
function _projectionCacheKey(domain: string): string {
  return domain.replace(/^www\./, "").trim().toLowerCase();
}

/**
 * Synchronous read of the last server projection for a domain (the
 * resolve-time overlay source). Returns `undefined` when the server has
 * never been reached for this domain; the caller then keeps its local
 * last-known/structural confidence (degraded, no learning).
 */
export function getCachedEdgeConfidenceProjection(
  domain: string,
): Record<string, number> | undefined {
  return _projectionCache.get(_projectionCacheKey(domain));
}

/** Test-only: clear the in-process projection cache. */
export function _resetProjectionCacheForTesting(): void {
  _projectionCache.clear();
}

/**
 * POST /v1/graph/confidence: report sanitized edge outcomes and/or request
 * the latest cross-user projection for a set of edges in one round-trip.
 *
 * This is the client side of the DAG moat: the online learning lives on the
 * server. On success the returned projection is cached in-process so the
 * synchronous resolve path can overlay it. The caller MUST treat a thrown
 * error as "backend unreachable" and fall back to last-known/local edge
 * confidences (degraded, no learning). Never hard-fail a resolve on this.
 */
export async function syncEdgeConfidence(
  domain: string,
  outcomes: EdgeOutcomeSignal[],
  edgeIds: string[] = [],
): Promise<EdgeConfidenceProjection> {
  const res = await graphApi<EdgeConfidenceProjection>("POST", "/v1/graph/confidence", {
    domain,
    outcomes,
    edge_ids: edgeIds,
  });
  const confidences = res?.confidences ?? {};
  if (Object.keys(confidences).length > 0) {
    const key = _projectionCacheKey(domain);
    // Merge so a read-only projection for a subset of edges doesn't drop
    // confidences learned from a prior outcome report.
    const prev = _projectionCache.get(key) ?? {};
    _projectionCache.set(key, { ...prev, ...confidences });
  }
  return {
    confidences,
    observations: res?.observations ?? {},
  };
}
