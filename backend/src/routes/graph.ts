import { Hono } from "hono";
import type { Env } from "../types.js";
import { resolveChain, predictNext, recordSession, recordNegative, checkCredits, getIntentCache, getCooccurrence, getEdges, graphProxy, upsertEdges } from "../services/graph.js";
import type { GraphNode, GraphEdge } from "../services/graph.js";
import { rateLimit } from "../middleware/rate-limit.js";
import { recordGraphFee, type GraphOperation } from "../services/fees.js";

/** Extract agent_id from Authorization header (Bearer token) if present. */
function extractAgentId(authHeader: string | undefined | null): string {
  if (!authHeader) return "anonymous";
  const token = authHeader.replace(/^Bearer\s+/i, "").trim();
  return token || "anonymous";
}

/** Record a graph fee in the background — never blocks or fails the response. */
function chargeFee(env: Env, agentId: string, op: GraphOperation): void {
  recordGraphFee(env, agentId, op).catch(() => { /* fee recording must not break the API */ });
}

export const graphRoutes = new Hono<{ Bindings: Env }>();

graphRoutes.use("/graph/*", rateLimit({ limit: 30, window: 60, prefix: "graph" }));

// POST /v1/graph/edges — upsert DAG edges for a domain
graphRoutes.post("/graph/edges", async (c) => {
  const { domain, node, edges } = await c.req.json<{
    domain: string;
    node: GraphNode;
    edges: GraphEdge[];
  }>();
  if (!domain || !node?.endpoint_id) return c.json({ error: "domain and node.endpoint_id required" }, 400);
  try {
    await upsertEdges(c.env, domain, node, edges);
    return c.json({ ok: true });
  } catch (err) {
    console.error("[graph/edges] error:", (err as Error).message);
    return c.json({ error: (err as Error).message }, 500);
  }
});

// POST /v1/graph/chain — resolve prerequisite chain for a target endpoint
graphRoutes.post("/graph/chain", async (c) => {
  const { domain, target_endpoint_id, available_bindings } = await c.req.json<{
    domain: string;
    target_endpoint_id: string;
    available_bindings?: string[];
  }>();
  if (!domain || !target_endpoint_id) return c.json({ error: "domain and target_endpoint_id required" }, 400);
  try {
    const agentId = extractAgentId(c.req.header("Authorization"));
    const chain = await resolveChain(c.env, domain, target_endpoint_id, available_bindings);
    chargeFee(c.env, agentId, "chain");
    return c.json(chain);
  } catch (err) {
    console.error("[graph/chain] error:", (err as Error).message);
    return c.json({ error: (err as Error).message }, 500);
  }
});

// GET /v1/graph/predict/:domain — get co-occurrence predictions
graphRoutes.get("/graph/predict/:domain", async (c) => {
  const domain = c.req.param("domain");
  const from = c.req.query("from");
  const k = parseInt(c.req.query("k") ?? "5", 10);
  if (!from) return c.json({ error: "from query param required" }, 400);
  try {
    const agentId = extractAgentId(c.req.header("Authorization"));
    const predictions = await predictNext(c.env, domain, from, k);
    chargeFee(c.env, agentId, "predict");
    return c.json(predictions);
  } catch (err) {
    console.error("[graph/predict] error:", (err as Error).message);
    return c.json({ error: (err as Error).message }, 500);
  }
});

// POST /v1/graph/session — record session action for co-occurrence learning
graphRoutes.post("/graph/session", async (c) => {
  const { session_id, action } = await c.req.json<{
    session_id: string;
    action: {
      intent: string;
      domain: string;
      endpoint_id: string;
      result: "success" | "failure" | "skip";
      timestamp?: number;
    };
  }>();
  if (!session_id || !action?.endpoint_id) {
    return c.json({ error: "session_id and action.endpoint_id required" }, 400);
  }
  try {
    const agentId = extractAgentId(c.req.header("Authorization"));
    await recordSession(c.env, session_id, action);
    chargeFee(c.env, agentId, "session");
    return c.json({ ok: true });
  } catch (err) {
    console.error("[graph/session] error:", (err as Error).message);
    return c.json({ error: (err as Error).message }, 500);
  }
});

// POST /v1/graph/negative — record a negative example
graphRoutes.post("/graph/negative", async (c) => {
  const { domain, intent_pattern, endpoint_id } = await c.req.json<{
    domain: string;
    intent_pattern: string;
    endpoint_id: string;
  }>();
  if (!domain || !intent_pattern || !endpoint_id) {
    return c.json({ error: "domain, intent_pattern, and endpoint_id required" }, 400);
  }
  try {
    const agentId = extractAgentId(c.req.header("Authorization"));
    await recordNegative(c.env, domain, intent_pattern, endpoint_id);
    chargeFee(c.env, agentId, "negative");
    return c.json({ ok: true });
  } catch (err) {
    console.error("[graph/negative] error:", (err as Error).message);
    return c.json({ error: (err as Error).message }, 500);
  }
});

// GET /v1/graph/credits — check remaining Graph API credits
graphRoutes.get("/graph/credits", async (c) => {
  try {
    const credits = await checkCredits(c.env);
    return c.json(credits);
  } catch (err) {
    console.error("[graph/credits] error:", (err as Error).message);
    return c.json({ error: (err as Error).message }, 500);
  }
});

// GET /v1/graph/intent-cache — check cached intent→endpoint routing
graphRoutes.get("/graph/intent-cache", async (c) => {
  const query = c.req.query("query");
  if (!query) return c.json({ error: "query param required" }, 400);
  try {
    const cache = await getIntentCache(c.env, query, c.req.query("domain"));
    return c.json(cache);
  } catch (err) {
    console.error("[graph/intent-cache] error:", (err as Error).message);
    return c.json({ error: (err as Error).message }, 500);
  }
});

// GET /v1/graph/cooccurrence/:domain — dump co-occurrence matrix
graphRoutes.get("/graph/cooccurrence/:domain", async (c) => {
  try {
    const matrix = await getCooccurrence(c.env, c.req.param("domain"));
    return c.json(matrix);
  } catch (err) {
    console.error("[graph/cooccurrence] error:", (err as Error).message);
    return c.json({ error: (err as Error).message }, 500);
  }
});

// GET /v1/graph/edges/:domain/:endpoint_id — read adjacency list
graphRoutes.get("/graph/edges/:domain/:endpoint_id", async (c) => {
  try {
    const edges = await getEdges(c.env, c.req.param("domain"), c.req.param("endpoint_id"));
    return c.json(edges);
  } catch (err) {
    console.error("[graph/edges] error:", (err as Error).message);
    return c.json({ error: (err as Error).message }, 500);
  }
});

// GET /v1/graph/proxy/* — pass-through to bolt instance
graphRoutes.get("/graph/proxy/*", async (c) => {
  // c.req.path is /graph/proxy/... (after /v1 mount)
  const subpath = c.req.path.replace(/^.*\/graph\/proxy\//, "");
  try {
    const result = await graphProxy(c.env, subpath);
    return c.json(result);
  } catch (err) {
    console.error("[graph/proxy] error:", (err as Error).message);
    return c.json({ error: (err as Error).message }, 500);
  }
});
