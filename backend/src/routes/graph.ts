import { Hono } from "hono";
import type { Env } from "../types.js";
import { resolveChain, predictNext, recordSession, recordNegative, checkCredits, checkGraphHealth, getIntentCache, getCooccurrence, getEdges, graphProxy, upsertEdges } from "../services/graph.js";
import { augmentEndpointsSemantic, type AugmentRequest } from "../services/semantic-augment.js";
import type { GraphNode, GraphEdge } from "../services/graph.js";
import { rateLimit } from "../middleware/rate-limit.js";
import { bearerAuth, requireSignedClient } from "../middleware/auth.js";
import { recordGraphFee, type GraphOperation } from "../services/fees.js";
import { ingestEdgeOutcomes, projectConfidences, type EdgeOutcomeSignal } from "../services/graph-confidence.js";
import { getNeonClient } from "../services/neon.js";

/** Record a graph fee in the background — never blocks or fails the response. */
function chargeFee(env: Env, agentId: string, op: GraphOperation): void {
  recordGraphFee(env, agentId, op).catch(() => { /* fee recording must not break the API */ });
}

export const graphRoutes = new Hono<{ Bindings: Env }>();

graphRoutes.use("/graph/*", rateLimit({ limit: 30, window: 60, prefix: "graph" }));

// GET /v1/graph/health — EmergentDB graph availability. Credit balance is not a gate.
graphRoutes.get("/graph/health", async (c) => {
  try {
    const health = await checkGraphHealth(c.env);
    return c.json({
      backend: "emergentdb",
      available: true,
      credit_balance_gates_graph: false,
      health,
    });
  } catch (err) {
    console.error("[graph/health] error:", (err as Error).message);
    return c.json({
      backend: "emergentdb",
      available: false,
      credit_balance_gates_graph: false,
      error: (err as Error).message,
    }, 503);
  }
});

// POST /v1/graph/edges — upsert DAG edges for a domain
graphRoutes.post("/graph/edges", bearerAuth, requireSignedClient, async (c) => {
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
// POST /v1/graph/augment-semantic: server-side endpoint-skeleton enrichment.
//
// The client sends already-sanitized endpoint skeletons UP (no secrets:
// sample_request / sample_response are compacted client-side before
// transit). The server runs the augmentation prompt against the
// configured semantic model and returns enriched per-endpoint metadata
// DOWN. The prompt + model orchestration live server-side
// (services/semantic-augment.ts) so the prompt is not shipped in the
// npm bundle and the model can be swapped via env without a client
// release.
//
// Best-effort by contract: this NEVER blocks the client's index/publish
// pipeline. Any failure (model unavailable, timeout, augment disabled)
// returns 200 with `{ endpoints: [] }`; the client then falls back to
// its local heuristic (generateLocalDescription). It is intentionally
// NOT a 4xx/5xx on augmentation failure. The client treats an empty
// list and a transport error identically (fall back), and a non-2xx
// would only add noise to client logs for an optional enrichment.
graphRoutes.post("/graph/augment-semantic", bearerAuth, requireSignedClient, async (c) => {
  let req: AugmentRequest;
  try {
    req = await c.req.json<AugmentRequest>();
  } catch {
    return c.json({ endpoints: [] }, 200);
  }
  if (!req || !Array.isArray(req.endpoints) || req.endpoints.length === 0) {
    return c.json({ endpoints: [] }, 200);
  }
  try {
    const result = await augmentEndpointsSemantic(c.env, req);
    return c.json(result);
  } catch (err) {
    console.error("[graph/augment-semantic] error:", (err as Error).message);
    return c.json({ endpoints: [] }, 200);
  }
});

// POST /v1/graph/confidence: server-authoritative edge-confidence sync.
//
// This is the DAG moat boundary. The client sends already-sanitized
// per-execution edge OUTCOMES up (domain + edge_id + succeeded + optional
// negative weight; no payloads, no auth context, no secrets) and receives
// the cross-user PROJECTED confidences back down. The learning math and the
// per-edge aggregate counters live server-side only; a forked client never
// sees them. When `outcomes` is empty the call is a read-only projection
// (used at resolve to overlay the latest cross-user confidence).
graphRoutes.post("/graph/confidence", bearerAuth, requireSignedClient, async (c) => {
  const { domain, outcomes, edge_ids } = await c.req.json<{
    domain: string;
    outcomes?: EdgeOutcomeSignal[];
    edge_ids?: string[];
  }>();
  if (!domain) return c.json({ error: "domain required" }, 400);
  const reported = Array.isArray(outcomes) ? outcomes : [];
  const wanted = Array.isArray(edge_ids) ? edge_ids : [];
  if (reported.length === 0 && wanted.length === 0) {
    return c.json({ error: "outcomes or edge_ids required" }, 400);
  }
  try {
    const agentId = c.get("agent_id");
    let projection = reported.length > 0
      ? await ingestEdgeOutcomes(c.env, domain, reported)
      : { confidences: {}, observations: {} };
    // Cover any read-only edge_ids the caller asked about that weren't in
    // the reported batch (resolve-time overlay path).
    const missing = wanted.filter((id) => !(id in projection.confidences));
    if (missing.length > 0) {
      const extra = await projectConfidences(c.env, domain, missing);
      projection = {
        confidences: { ...projection.confidences, ...extra.confidences },
        observations: { ...projection.observations, ...extra.observations },
      };
    }
    chargeFee(c.env, agentId, "session");
    return c.json({ ok: true, ...projection });
  } catch (err) {
    console.error("[graph/confidence] error:", (err as Error).message);
    return c.json({ error: (err as Error).message }, 500);
  }
});

// POST /v1/graph/chain — resolve prerequisite chain for a target endpoint
graphRoutes.post("/graph/chain", bearerAuth, requireSignedClient, async (c) => {
  const { domain, target_endpoint_id, available_bindings } = await c.req.json<{
    domain: string;
    target_endpoint_id: string;
    available_bindings?: string[];
  }>();
  if (!domain || !target_endpoint_id) return c.json({ error: "domain and target_endpoint_id required" }, 400);
  try {
    const agentId = c.get("agent_id");
    const chain = await resolveChain(c.env, domain, target_endpoint_id, available_bindings);
    chargeFee(c.env, agentId, "chain");
    return c.json(chain);
  } catch (err) {
    console.error("[graph/chain] error:", (err as Error).message);
    return c.json({ error: (err as Error).message }, 500);
  }
});

// GET /v1/graph/predict/:domain — get co-occurrence predictions
graphRoutes.get("/graph/predict/:domain", bearerAuth, requireSignedClient, async (c) => {
  const domain = c.req.param("domain");
  const from = c.req.query("from");
  const k = parseInt(c.req.query("k") ?? "5", 10);
  if (!domain) return c.json({ error: "domain path param required" }, 400);
  if (!from) return c.json({ error: "from query param required" }, 400);
  try {
    const agentId = c.get("agent_id");
    const predictions = await predictNext(c.env, domain, from, k);
    chargeFee(c.env, agentId, "predict");
    return c.json(predictions);
  } catch (err) {
    console.error("[graph/predict] error:", (err as Error).message);
    return c.json({ error: (err as Error).message }, 500);
  }
});

// POST /v1/graph/session — record session action for co-occurrence learning
graphRoutes.post("/graph/session", bearerAuth, requireSignedClient, async (c) => {
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
    const agentId = c.get("agent_id");
    await recordSession(c.env, session_id, action);
    chargeFee(c.env, agentId, "session");
    return c.json({ ok: true });
  } catch (err) {
    console.error("[graph/session] error:", (err as Error).message);
    return c.json({ error: (err as Error).message }, 500);
  }
});

// POST /v1/graph/negative — record a negative example
graphRoutes.post("/graph/negative", bearerAuth, requireSignedClient, async (c) => {
  const { domain, intent_pattern, endpoint_id } = await c.req.json<{
    domain: string;
    intent_pattern: string;
    endpoint_id: string;
  }>();
  if (!domain || !intent_pattern || !endpoint_id) {
    return c.json({ error: "domain, intent_pattern, and endpoint_id required" }, 400);
  }
  try {
    const agentId = c.get("agent_id");
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
    return c.json({
      ...(credits as Record<string, unknown>),
      credit_balance_gates_graph: false,
    });
  } catch (err) {
    console.error("[graph/credits] error:", (err as Error).message);
    return c.json({
      available: false,
      credit_balance_gates_graph: false,
      error: (err as Error).message,
    });
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

// GET /v1/graph/proxy/* — pass-through to upstream graph backend.
//
// SECURITY: this route forwards traffic to the upstream graph (EmergentDB)
// using EMERGENTDB_API_KEY. Without auth + path normalisation, anyone could
// burn the org's API quota or smuggle path traversal into upstream-paths.
// We require a bearer token and a strict subpath shape.
const GRAPH_PROXY_SUBPATH_RE = /^[A-Za-z0-9_/.-]+$/;
graphRoutes.get("/graph/proxy/*", bearerAuth, async (c) => {
  // c.req.path is /graph/proxy/... (after /v1 mount)
  const subpath = c.req.path.replace(/^.*\/graph\/proxy\//, "");
  if (!subpath) return c.json({ error: "subpath required" }, 400);
  if (subpath.length > 256) return c.json({ error: "subpath too long" }, 400);
  if (!GRAPH_PROXY_SUBPATH_RE.test(subpath)) {
    return c.json({ error: "subpath must match [A-Za-z0-9_/.-]+" }, 400);
  }
  if (subpath.includes("..") || subpath.includes("//") || subpath.startsWith("/")) {
    return c.json({ error: "subpath must not contain .. or leading slashes" }, 400);
  }
  try {
    const result = await graphProxy(c.env, subpath);
    return c.json(result);
  } catch (err) {
    console.error("[graph/proxy] error:", (err as Error).message);
    return c.json({ error: "graph proxy failed" }, 502);
  }
});

// GET /v1/graph/endpoint-penalties — read telemetry_executions to surface per-endpoint
// failure counts for the last 7 days. Used by the resolve/ranking path so that endpoints
// with repeated bad outcomes (fail or antibot_block) are penalised in resolve results.
//
// The ledger is write-and-read, not write-only: POST /telemetry/execute writes rows;
// this route reads them back to feed the ranker. Falls open gracefully when DATABASE_URL
// is absent or the telemetry_executions table does not yet exist.
//
// Query params:
//   endpoint_ids  comma-separated list of endpoint_id values to look up  (required)
//   intent        optional intent string; if supplied, restricts to rows whose intent
//                 contains this string (case-insensitive ILIKE match)
//
// Response:
//   { penalties: { [endpoint_id]: { fail_count: number; penalty_score: number } } }
//
// penalty_score formula: min(1.0, fail_count * 0.15)
// A penalty of 0.15 per failure, capped at 1.0 (full demotion).
// The caller subtracts this from the endpoint's normalised score before ranking.
//
// SQL note — telemetry_executions DDL (if not yet created):
//   CREATE TABLE IF NOT EXISTS telemetry_executions (
//     id            BIGSERIAL PRIMARY KEY,
//     intent        TEXT,
//     skill_id      TEXT NOT NULL,
//     endpoint_id   TEXT NOT NULL,
//     outcome       TEXT NOT NULL,       -- 'success' | 'fail' | 'antibot_block' | ...
//     status_code   INTEGER,
//     latency_ms    INTEGER,
//     proxy_used    BOOLEAN DEFAULT FALSE,
//     block_signals JSONB DEFAULT '[]',
//     received_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
//   );
//   CREATE INDEX IF NOT EXISTS telemetry_executions_endpoint_outcome
//     ON telemetry_executions (endpoint_id, outcome, received_at);
graphRoutes.get("/graph/endpoint-penalties", bearerAuth, async (c) => {
  const rawIds = c.req.query("endpoint_ids");
  if (!rawIds) return c.json({ error: "endpoint_ids query param required" }, 400);

  const endpointIds = rawIds
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
  if (endpointIds.length === 0) return c.json({ error: "endpoint_ids must not be empty" }, 400);
  if (endpointIds.length > 200) return c.json({ error: "endpoint_ids: max 200 per request" }, 400);

  const intent = c.req.query("intent") ?? null;

  // Default response shape — returned verbatim when storage is absent.
  const penalties: Record<string, { fail_count: number; penalty_score: number }> = {};

  if (!c.env.DATABASE_URL) {
    return c.json({ penalties, _unconfigured: true });
  }

  try {
    const sql = await getNeonClient(c.env.DATABASE_URL);
    const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();

    // Count bad outcomes per endpoint_id from telemetry_executions over the
    // last 7 days. If `intent` is supplied, restrict to similar intents using
    // a case-insensitive substring match so the penalty is intent-scoped.
    let rows: Array<{ endpoint_id: string; fail_count: string | number }>;
    if (intent) {
      rows = await sql`
        SELECT endpoint_id, COUNT(*) AS fail_count
        FROM telemetry_executions
        WHERE endpoint_id = ANY(${endpointIds})
          AND outcome IN ('fail', 'antibot_block')
          AND received_at >= ${sevenDaysAgo}
          AND intent ILIKE ${'%' + intent + '%'}
        GROUP BY endpoint_id
      ` as Array<{ endpoint_id: string; fail_count: string | number }>;
    } else {
      rows = await sql`
        SELECT endpoint_id, COUNT(*) AS fail_count
        FROM telemetry_executions
        WHERE endpoint_id = ANY(${endpointIds})
          AND outcome IN ('fail', 'antibot_block')
          AND received_at >= ${sevenDaysAgo}
        GROUP BY endpoint_id
      ` as Array<{ endpoint_id: string; fail_count: string | number }>;
    }

    for (const row of rows) {
      const failCount = Number(row.fail_count);
      penalties[row.endpoint_id] = {
        fail_count: failCount,
        penalty_score: Math.min(1.0, failCount * 0.15),
      };
    }

    return c.json({ penalties });
  } catch (err) {
    // Fall open — if the table doesn't exist or the query fails, return empty
    // penalties so the ranker continues unaffected.
    console.warn(
      "[graph/endpoint-penalties] query failed (falling open):",
      err instanceof Error ? err.message : String(err),
    );
    return c.json({ penalties, _error: "query_failed" });
  }
});
