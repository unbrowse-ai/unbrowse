import { getApiKey } from "./index.js";

const API_URL = process.env.UNBROWSE_BACKEND_URL ?? "https://beta-api.unbrowse.ai";
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

/** POST /v1/graph/negative — report an explicit negative signal (fire-and-forget) */
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
