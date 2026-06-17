import { Hono } from "hono";
import type { Env, FunnelEventName, FunnelEventSource, WebTelemetryEventName } from "../types.js";
import { bearerAuth, optionalAuth } from "../middleware/auth.js";
import { recordFunnelEvent } from "../services/funnel.js";
import { recordInstallTelemetry } from "../services/install-telemetry.js";
import { recordWebTelemetry } from "../services/acquisition.js";
import { getLandingHomepageInstallAttribution } from "../services/landing-experiments.js";
import { recordSurfaceError, loadSurfaceErrors, recordUsagePing, loadUsagePings } from "../services/issues.js";

export const telemetryRoutes = new Hono<{ Bindings: Env; Variables: { agent_id: string } }>();

telemetryRoutes.use("/telemetry/events", optionalAuth);
telemetryRoutes.use("/telemetry/install", optionalAuth);
telemetryRoutes.use("/telemetry/issue", optionalAuth);
telemetryRoutes.use("/telemetry/usage", optionalAuth);

async function hashIpPrefix(raw: string): Promise<string> {
  const bytes = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(raw));
  return Array.from(new Uint8Array(bytes)).map((byte) => byte.toString(16).padStart(2, "0")).join("").slice(0, 16);
}

async function deriveIpPrefixHash(c: { req: { header(name: string): string | undefined } }): Promise<string | undefined> {
  const raw = c.req.header("cf-connecting-ip") ?? c.req.header("x-forwarded-for")?.split(",")[0]?.trim();
  if (!raw) return undefined;
  const prefix = raw.includes(":")
    ? raw.split(":").slice(0, 4).join(":")
    : raw.split(".").slice(0, 3).join(".");
  if (!prefix) return undefined;
  return hashIpPrefix(prefix);
}

telemetryRoutes.post("/telemetry/events", async (c) => {
  const body = await c.req.json<{
    install_id?: string;
    session_id?: string;
    landing_token?: string;
    name?: FunnelEventName | string;
    source?: FunnelEventSource;
    host_type?: string;
    created_at?: string;
    properties?: Record<string, unknown>;
  }>().catch(() => null);

  if (!body?.install_id || !body.name || !body.source) {
    return c.json({ error: "install_id, name, and source are required" }, 400);
  }

  const agentId = c.get("agent_id");
  const attribution = await getLandingHomepageInstallAttribution(c.env, body.install_id, body.landing_token);
  const stored = await recordFunnelEvent(c.env, {
    install_id: body.install_id,
    session_id: body.session_id,
    name: body.name,
    source: body.source,
    host_type: body.host_type,
    landing_experiment_id: attribution?.experiment_id,
    landing_variant_id: attribution?.variant_id,
    landing_visitor_id: attribution?.visitor_id,
    landing_session_id: attribution?.session_id,
    landing_token_id: attribution?.token_id,
    created_at: body.created_at,
    properties: body.properties,
    agent_id: agentId && agentId !== "__admin__" ? agentId : null,
  });

  c.header("Cache-Control", "no-store");
  c.header("Access-Control-Allow-Origin", "*");
  return c.json({ ok: true, event_id: stored.event_id });
});

telemetryRoutes.post("/telemetry/install", async (c) => {
  const body = await c.req.json<{
    install_id?: string;
    landing_token?: string;
    source?: string;
    host_type?: string;
    skill?: string;
    skill_version?: string;
    status?: string;
    created_at?: string;
    properties?: Record<string, unknown>;
  }>().catch(() => null);

  if (!body?.install_id || !body.source) {
    return c.json({ error: "install_id and source are required" }, 400);
  }

  const agentId = c.get("agent_id");
  const attribution = await getLandingHomepageInstallAttribution(c.env, body.install_id, body.landing_token);
  const stored = await recordInstallTelemetry(c.env, {
    install_id: body.install_id,
    source: body.source,
    host_type: body.host_type,
    landing_experiment_id: attribution?.experiment_id,
    landing_variant_id: attribution?.variant_id,
    landing_visitor_id: attribution?.visitor_id,
    landing_session_id: attribution?.session_id,
    landing_token_id: attribution?.token_id,
    skill: body.skill ?? "unbrowse",
    skill_version: body.skill_version,
    status: body.status ?? "installed",
    created_at: body.created_at,
    properties: body.properties,
    agent_id: agentId && agentId !== "__admin__" ? agentId : null,
  });

  c.header("Cache-Control", "no-store");
  c.header("Access-Control-Allow-Origin", "*");
  return c.json({ ok: true, event_id: stored.event_id });
});

telemetryRoutes.post("/telemetry/web", async (c) => {
  const body = await c.req.json<{
    visitor_id?: string;
    session_id?: string;
    name?: WebTelemetryEventName | string;
    experiment_id?: string;
    variant_id?: string;
    path?: string;
    referrer?: string | null;
    created_at?: string;
    properties?: Record<string, unknown>;
  }>().catch(() => null);

  if (!body?.visitor_id || !body.session_id || !body.name) {
    return c.json({ error: "visitor_id, session_id, and name are required" }, 400);
  }

  const stored = await recordWebTelemetry(c.env, {
    visitor_id: body.visitor_id,
    session_id: body.session_id,
    name: body.name,
    experiment_id: body.experiment_id,
    variant_id: body.variant_id,
    path: body.path,
    referrer: body.referrer,
    ip_prefix_hash: await deriveIpPrefixHash(c),
    created_at: body.created_at,
    properties: body.properties,
  });

  c.header("Cache-Control", "no-store");
  c.header("Access-Control-Allow-Origin", "*");
  return c.json({ ok: true, event_id: stored.event_id });
});


// ---------------------------------------------------------------------------
// Surface-error feed — the "secret faults" users hit across CLI / FE / backend.
// POST /telemetry/issue  — ingest one error event (fire-and-forget, optionalAuth).
// GET  /telemetry/issues — admin read: aggregated + recent, for the internal dashboard.
// Low-volume KV-backed (see services/issues.ts), distinct from the retired
// high-volume session store.
// ---------------------------------------------------------------------------
telemetryRoutes.post("/telemetry/issue", async (c) => {
  const body = await c.req.json<{
    surface?: string;
    kind?: string;
    message?: string;
    context?: Record<string, unknown>;
    install_id?: string;
    session_id?: string;
    version?: string;
    created_at?: string;
  }>().catch(() => null);
  if (!body?.surface || !body.kind) {
    return c.json({ error: "surface and kind are required" }, 400);
  }
  const agentId = c.get("agent_id");
  const stored = await recordSurfaceError(c.env, {
    surface: body.surface,
    kind: body.kind,
    message: body.message,
    context: body.context,
    install_id: body.install_id,
    session_id: body.session_id,
    version: body.version,
    created_at: body.created_at,
    agent_id: agentId && agentId !== "__admin__" ? agentId : null,
  });
  c.header("Cache-Control", "no-store");
  c.header("Access-Control-Allow-Origin", "*");
  return c.json({ ok: true, event_id: stored.event_id });
});

// One usage ping per CLI invocation — the "is anyone using it?" signal.
telemetryRoutes.post("/telemetry/usage", async (c) => {
  const body = await c.req.json<{
    verb?: string;
    version?: string;
    install_id?: string;
    created_at?: string;
  }>().catch(() => null);
  if (!body?.verb) {
    return c.json({ error: "verb is required" }, 400);
  }
  const agentId = c.get("agent_id");
  const stored = await recordUsagePing(c.env, {
    verb: body.verb,
    version: body.version,
    install_id: body.install_id,
    created_at: body.created_at,
    agent_id: agentId && agentId !== "__admin__" ? agentId : null,
  });
  c.header("Cache-Control", "no-store");
  c.header("Access-Control-Allow-Origin", "*");
  return c.json({ ok: true, event_id: stored.event_id });
});

telemetryRoutes.get("/telemetry/issues", optionalAuth, async (c) => {
  // Read access: the __admin__ key OR the internal-dashboard password (the page is
  // already edge-gated by the same secret). optionalAuth (not bearerAuth) so a
  // password bearer isn't rejected as an invalid API key before we can check it.
  const tok = (c.req.header("authorization") ?? "").replace(/^Bearer\s+/i, "").trim();
  const dashOk = !!c.env.INTERNAL_AUTH_PASSWORD && tok === c.env.INTERNAL_AUTH_PASSWORD;
  if (c.get("agent_id") !== "__admin__" && !dashOk) {
    return c.json({ error: "admin or dashboard token required" }, 403);
  }
  const days = Number(c.req.query("days") ?? "7") || 7;
  const [summary, usage] = await Promise.all([loadSurfaceErrors(c.env, days), loadUsagePings(c.env, days)]);
  c.header("Cache-Control", "no-store");
  return c.json({ ok: true, generated_at: new Date().toISOString(), days, ...summary, usage });
});

// ---------------------------------------------------------------------------
// MCP session bug-report telemetry (Phase 3, docs/mcp-telemetry-plan.md)
// ---------------------------------------------------------------------------
//
// POST /telemetry/session     — receive a session JSONL trace from a client
// DELETE /telemetry/sessions  — purge by client_seed (opt-out / GDPR)
//
// Storage: RETIRED with the Neon->IQ migration (2026-06). These admin-only
// session/analytics endpoints validate input but no longer persist. The
// cohort/retention/aggregation queries had no efficient KV form, and
// re-architecting telemetry onto a new store is an explicit non-goal — so the
// analytics feed was retired rather than ported. Endpoints below acknowledge
// requests (so fire-and-forget clients never error) and return
// reason:"telemetry_storage_retired".

const MAX_EVENTS_PER_SESSION = 2_000;
const MAX_PAYLOAD_BYTES = 256_000;
const MAX_FIELD_BYTES = 4_096;
const RATE_LIMIT_PER_MIN = 60;

type TelemetryEvent = Record<string, unknown> & { event?: string; ts?: string };

function validateEvent(ev: unknown): { ok: true; ev: TelemetryEvent } | { ok: false; reason: string } {
  if (!ev || typeof ev !== "object") return { ok: false, reason: "event_not_object" };
  const obj = ev as TelemetryEvent;
  if (typeof obj.event !== "string") return { ok: false, reason: "event_missing_event_field" };
  if (typeof obj.ts !== "string") return { ok: false, reason: "event_missing_ts_field" };
  for (const [k, v] of Object.entries(obj)) {
    if (typeof v === "string" && v.length > MAX_FIELD_BYTES) {
      return { ok: false, reason: `field_too_large:${k}` };
    }
  }
  return { ok: true, ev: obj };
}

telemetryRoutes.post("/telemetry/session", async (c) => {
  const raw = await c.req.text();
  if (raw.length > MAX_PAYLOAD_BYTES) {
    return c.json({ error: "payload_too_large", limit: MAX_PAYLOAD_BYTES, received: raw.length }, 413);
  }
  let body: { session_id?: string; events?: unknown[] };
  try {
    body = JSON.parse(raw);
  } catch {
    return c.json({ error: "invalid_json" }, 400);
  }
  if (!body.session_id || typeof body.session_id !== "string") {
    return c.json({ error: "session_id_required" }, 400);
  }
  if (!Array.isArray(body.events) || body.events.length === 0) {
    return c.json({ error: "events_required" }, 400);
  }
  if (body.events.length > MAX_EVENTS_PER_SESSION) {
    return c.json({ error: "too_many_events", limit: MAX_EVENTS_PER_SESSION }, 413);
  }
  for (const ev of body.events) {
    const v = validateEvent(ev);
    if (!v.ok) return c.json({ error: "invalid_event", reason: v.reason }, 400);
  }

  // Storage retired with the Neon->IQ migration. Validation above still
  // rejects malformed payloads; accepted events are acknowledged but not
  // persisted. Acknowledging (not erroring) keeps fire-and-forget MCP clients
  // from surfacing a failure on a retired analytics feed.
  return c.json({
    ok: true,
    stored: false,
    reason: "telemetry_storage_retired",
    session_id: body.session_id,
  });
});

telemetryRoutes.delete("/telemetry/sessions", async (c) => {
  const seed = c.req.query("seed");
  if (!seed) return c.json({ error: "seed_required" }, 400);
  // Storage retired: nothing is persisted, so there is nothing to delete.
  // Returns ok so opt-out / GDPR-erasure clients get a clean success.
  return c.json({ ok: true, deleted: 0, reason: "telemetry_storage_retired" });
});

// ============================================================================
// Admin reader for the autonomous bench-feeder.
// Surfaces recent failed/partial intent reflections so the agent (or a cron
// worker) can read them, judge in-thread which are good benchmark probes,
// and propose new corpus rows for harness/probes/corpus-gate.txt.
// Mirrors the admin-gate shape used in routes/ops.ts. Substrate-faithful:
// emits raw evidence; never auto-merges into the bench corpus.
// ============================================================================
telemetryRoutes.get("/telemetry/recent-failures", bearerAuth, async (c) => {
  const agentId = c.get("agent_id");
  if (agentId !== "__admin__") {
    return c.json({ error: "Admin only" }, 403);
  }
  // Storage retired with Neon->IQ. The bench-feeder failure feed was admin-only
  // analytics; it returns an empty set rather than a broken store.
  c.header("Cache-Control", "no-store");
  return c.json({ ok: true, count: 0, failures: [], reason: "telemetry_storage_retired" });
});

// ============================================================================
// Power-user retention endpoint (Layer 11 of funnel-tracking plan).
// Surfaces DAU / WAU / MAU + d7 / d30 retention + repeat-MCP-tool-call
// frequency from telemetry_sessions. Admin-bearer-gated (mirrors
// /telemetry/recent-failures). Substrate-faithful: emits raw aggregates
// only, never a "healthy/unhealthy" verdict. Agent + dashboard judge.
// ============================================================================
telemetryRoutes.get("/telemetry/retention", bearerAuth, async (c) => {
  const agentId = c.get("agent_id");
  if (agentId !== "__admin__") {
    return c.json({ error: "Admin only" }, 403);
  }
  // Storage retired with Neon->IQ. DAU/WAU/MAU + cohort retention were
  // Postgres aggregations with no efficient KV form; the dashboard feed is
  // retired rather than re-architected (explicit non-goal). Returns zeros.
  c.header("Cache-Control", "no-store");
  return c.json({
    ok: true,
    generated_at: new Date().toISOString(),
    reason: "telemetry_storage_retired",
    active_users: { dau: 0, wau: 0, mau: 0 },
    activity: { sessions_24h: 0, sessions_7d: 0, tool_calls_7d: 0 },
    retention: { d7: { cohort_size: 0, retained: 0 }, d30: { cohort_size: 0, retained: 0 } },
    power_users_7d: 0,
  });
});

// ============================================================================
// Per-execute telemetry ledger (semantic resolution improvement feed).
// Receives one row per executeEndpoint call: intent, skill_id, endpoint_id,
// outcome, status_code, latency_ms, proxy_used, block_signals.
// Storage RETIRED with Neon->IQ. This per-execute ledger fed the endpoint
// penalty scoring in routes/graph.ts (a Postgres GROUP BY); both were retired
// together. Acknowledges (200 ok=true, stored=false) so fire-and-forget
// callers are never penalised.
// ============================================================================
telemetryRoutes.post("/telemetry/execute", async (c) => {
  const body = await c.req.json<{
    skill_id?: string;
    endpoint_id?: string;
    outcome?: string;
  }>().catch(() => null);

  if (!body?.skill_id || !body.endpoint_id || !body.outcome) {
    return c.json({ error: "skill_id, endpoint_id, and outcome are required" }, 400);
  }

  c.header("Cache-Control", "no-store");
  c.header("Access-Control-Allow-Origin", "*");
  return c.json({ ok: true, stored: false, reason: "telemetry_storage_retired" });
});
