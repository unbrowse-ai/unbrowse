import { Hono } from "hono";
import type { Env, FunnelEventName, FunnelEventSource, WebTelemetryEventName } from "../types.js";
import { bearerAuth, optionalAuth } from "../middleware/auth.js";
import { recordFunnelEvent } from "../services/funnel.js";
import { recordInstallTelemetry } from "../services/install-telemetry.js";
import { recordWebTelemetry } from "../services/acquisition.js";
import { getLandingHomepageInstallAttribution } from "../services/landing-experiments.js";

export const telemetryRoutes = new Hono<{ Bindings: Env; Variables: { agent_id: string } }>();

telemetryRoutes.use("/telemetry/events", optionalAuth);
telemetryRoutes.use("/telemetry/install", optionalAuth);

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
// MCP session bug-report telemetry (Phase 3, docs/mcp-telemetry-plan.md)
// ---------------------------------------------------------------------------
//
// POST /telemetry/session     — receive a session JSONL trace from a client
// DELETE /telemetry/sessions  — purge by client_seed (opt-out / GDPR)
//
// Storage: Neon Postgres via DATABASE_URL (matches existing pattern in
// backend/src/services/{neon,traction,stripe}.ts). Schema defined in
// backend/schema/telemetry-sessions.sql.

import { getNeonClient } from "../services/neon.js";

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

  const env = c.env;
  if (!env.DATABASE_URL) {
    return c.json({ error: "storage_not_configured" }, 503);
  }

  const fingerprint = c.req.header("x-agent-kind-fingerprint") ?? "unknown";

  // Per-fingerprint rate limit via a transient row in app_kv. Falls open if
  // the rate-limit query throws — we would rather lose a rate limit than
  // drop telemetry. (Same posture as the rest of this route.)
  try {
    const sql = await getNeonClient(env.DATABASE_URL);
    const minute = Math.floor(Date.now() / 60_000);
    const rateKey = `telemetry-rate:${fingerprint}:${minute}`;
    const rows = await sql`
      SELECT value FROM app_kv WHERE namespace = ${"telemetry-rate"} AND key = ${rateKey}
    ` as Array<{ value: string }>;
    const current = parseInt(rows[0]?.value ?? "0", 10);
    if (current >= RATE_LIMIT_PER_MIN) {
      return c.json({ error: "rate_limited", limit: `${RATE_LIMIT_PER_MIN}/min` }, 429);
    }
    const next = String(current + 1);
    const expires = new Date(Date.now() + 120_000).toISOString();
    await sql`
      INSERT INTO app_kv (namespace, key, value, expires_at, updated_at)
      VALUES (${"telemetry-rate"}, ${rateKey}, ${next}, ${expires}, NOW())
      ON CONFLICT (namespace, key) DO UPDATE SET value = EXCLUDED.value, expires_at = EXCLUDED.expires_at, updated_at = NOW()
    `;
  } catch (err) {
    console.warn("[telemetry/session] rate-limit check failed:", err instanceof Error ? err.message : String(err));
  }

  // Derive summary metadata for indexing/triage.
  const start = body.events.find((e): e is TelemetryEvent => (e as TelemetryEvent)?.event === "session_start");
  const end = body.events.find((e): e is TelemetryEvent => (e as TelemetryEvent)?.event === "session_end");
  const refl = body.events.find((e): e is TelemetryEvent => (e as TelemetryEvent)?.event === "reflection");
  const reflMissing = body.events.find((e): e is TelemetryEvent => (e as TelemetryEvent)?.event === "reflection_missing");

  const reflection_status: string =
    typeof refl?.intent_status === "string"
      ? String(refl.intent_status)
      : reflMissing
        ? "missing"
        : "unknown";

  const duration_ms_total = typeof end?.duration_ms_total === "number" ? end.duration_ms_total : null;
  const tool_calls_total = typeof end?.tool_calls_total === "number" ? end.tool_calls_total : null;
  const errors_total = typeof end?.errors_total === "number" ? end.errors_total : null;
  const mcp_version = typeof start?.mcp_version === "string" ? start.mcp_version : null;
  const platform = typeof start?.platform === "string" ? start.platform : null;
  const client_seed_fp = typeof start?.client_seed_fp === "string" ? start.client_seed_fp : null;

  try {
    const sql = await getNeonClient(env.DATABASE_URL);
    await sql`
      INSERT INTO telemetry_sessions
        (session_id, received_at, duration_ms_total, tool_calls_total, errors_total,
         reflection_status, events_json, agent_kind_fingerprint, mcp_version, platform, client_seed_fp)
      VALUES (
        ${body.session_id}, NOW(), ${duration_ms_total}, ${tool_calls_total}, ${errors_total},
        ${reflection_status}, ${JSON.stringify(body.events)}, ${fingerprint}, ${mcp_version},
        ${platform}, ${client_seed_fp}
      )
      ON CONFLICT (session_id) DO UPDATE SET
        received_at = NOW(),
        duration_ms_total = EXCLUDED.duration_ms_total,
        tool_calls_total = EXCLUDED.tool_calls_total,
        errors_total = EXCLUDED.errors_total,
        reflection_status = EXCLUDED.reflection_status,
        events_json = EXCLUDED.events_json,
        agent_kind_fingerprint = EXCLUDED.agent_kind_fingerprint,
        mcp_version = EXCLUDED.mcp_version,
        platform = EXCLUDED.platform,
        client_seed_fp = EXCLUDED.client_seed_fp
    `;
  } catch (err) {
    console.error("[telemetry/session] Postgres insert failed:", err instanceof Error ? err.message : String(err));
    return c.json({ error: "storage_failed" }, 500);
  }

  return c.json({ ok: true, session_id: body.session_id, events_stored: body.events.length });
});

telemetryRoutes.delete("/telemetry/sessions", async (c) => {
  const seed = c.req.query("seed");
  if (!seed) return c.json({ error: "seed_required" }, 400);
  if (!c.env.DATABASE_URL) return c.json({ error: "storage_not_configured" }, 503);

  // Hash on the server side. The client sent its raw seed; we apply sha256 ×
  // 16-char-hex to match the client_seed_fp stored at session_start.
  const bytes = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(seed));
  const seedFp = Array.from(new Uint8Array(bytes))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("")
    .slice(0, 16);

  try {
    const sql = await getNeonClient(c.env.DATABASE_URL);
    const result = await sql`
      DELETE FROM telemetry_sessions WHERE client_seed_fp = ${seedFp}
    ` as { count?: number };
    // postgres.js returns rows; neon serverless returns Array with .count.
    // Fall back to length on the array shape.
    const deleted = (result as { count?: number; length?: number }).count ?? (result as { length?: number }).length ?? 0;
    return c.json({ ok: true, deleted });
  } catch (err) {
    console.error("[telemetry/sessions DELETE] failed:", err instanceof Error ? err.message : String(err));
    return c.json({ error: "delete_failed" }, 500);
  }
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
  if (!c.env.DATABASE_URL) {
    return c.json({ error: "storage_not_configured" }, 503);
  }

  const limitRaw = parseInt(c.req.query("limit") ?? "200", 10);
  const limit = Number.isFinite(limitRaw) ? Math.max(1, Math.min(limitRaw, 1000)) : 200;
  const sinceRaw = c.req.query("since");
  const since = sinceRaw && !Number.isNaN(Date.parse(sinceRaw))
    ? new Date(sinceRaw).toISOString()
    : new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();

  try {
    const sql = await getNeonClient(c.env.DATABASE_URL);
    const rows = await sql`
      SELECT session_id, received_at, reflection_status, events_json,
             mcp_version, platform, agent_kind_fingerprint
      FROM telemetry_sessions
      WHERE reflection_status IN ('failed', 'partial', 'unknown', 'missing')
        AND received_at >= ${since}
      ORDER BY received_at DESC
      LIMIT ${limit}
    ` as Array<{
      session_id: string;
      received_at: string;
      reflection_status: string;
      events_json: unknown;
      mcp_version: string | null;
      platform: string | null;
      agent_kind_fingerprint: string;
    }>;

    const failures: Array<Record<string, unknown>> = [];
    for (const row of rows) {
      const events = Array.isArray(row.events_json) ? row.events_json : [];
      const refl = events.find((e: unknown): e is Record<string, unknown> => {
        return Boolean(e && typeof e === "object" && (e as { event?: string }).event === "reflection");
      });
      const sessionStart = events.find((e: unknown): e is Record<string, unknown> => {
        return Boolean(e && typeof e === "object" && (e as { event?: string }).event === "session_start");
      });
      const lastTool = [...events].reverse().find((e: unknown): e is Record<string, unknown> => {
        const ev = (e && typeof e === "object") ? (e as { event?: string }).event : undefined;
        return typeof ev === "string" && (ev === "tool_call" || ev === "tool_result" || ev === "error");
      });

      failures.push({
        session_id: row.session_id,
        received_at: row.received_at,
        reflection_status: row.reflection_status,
        intent: refl?.intent ?? sessionStart?.intent ?? null,
        url: refl?.url ?? sessionStart?.url ?? null,
        intent_status: refl?.intent_status ?? null,
        error_class: lastTool?.error_class ?? lastTool?.error ?? null,
        last_tool: lastTool?.tool ?? lastTool?.name ?? null,
        mcp_version: row.mcp_version,
        platform: row.platform,
        agent_kind_fingerprint: row.agent_kind_fingerprint,
      });
    }

    c.header("Cache-Control", "no-store");
    return c.json({
      ok: true,
      since,
      limit,
      count: failures.length,
      failures,
    });
  } catch (err) {
    console.error("[telemetry/recent-failures] query failed:", err instanceof Error ? err.message : String(err));
    return c.json({ error: "query_failed" }, 500);
  }
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
  if (!c.env.DATABASE_URL) {
    return c.json({ error: "storage_not_configured" }, 503);
  }

  try {
    const sql = await getNeonClient(c.env.DATABASE_URL);
    const [aggregates] = await sql`
      SELECT
        COUNT(DISTINCT client_seed_fp) FILTER (WHERE received_at >= NOW() - INTERVAL '24 hours') AS dau,
        COUNT(DISTINCT client_seed_fp) FILTER (WHERE received_at >= NOW() - INTERVAL '7 days')   AS wau,
        COUNT(DISTINCT client_seed_fp) FILTER (WHERE received_at >= NOW() - INTERVAL '30 days')  AS mau,
        COUNT(*)                       FILTER (WHERE received_at >= NOW() - INTERVAL '24 hours') AS sessions_24h,
        COUNT(*)                       FILTER (WHERE received_at >= NOW() - INTERVAL '7 days')   AS sessions_7d,
        COALESCE(SUM(tool_calls_total) FILTER (WHERE received_at >= NOW() - INTERVAL '7 days'),  0) AS tool_calls_7d,
        COUNT(DISTINCT client_seed_fp) FILTER (
          WHERE received_at >= NOW() - INTERVAL '7 days'
          AND tool_calls_total IS NOT NULL AND tool_calls_total >= 10
        ) AS power_users_7d
      FROM telemetry_sessions
    ` as Array<{
      dau: string | number; wau: string | number; mau: string | number;
      sessions_24h: string | number; sessions_7d: string | number;
      tool_calls_7d: string | number; power_users_7d: string | number;
    }>;

    // d7 retention: of distinct fingerprints first-seen 7-14 days ago,
    // how many returned in the last 7 days.
    const [retention_d7] = await sql`
      WITH first_seen AS (
        SELECT client_seed_fp, MIN(received_at) AS first_at
        FROM telemetry_sessions
        WHERE client_seed_fp IS NOT NULL
        GROUP BY client_seed_fp
      ),
      cohort_d7 AS (
        SELECT client_seed_fp FROM first_seen
        WHERE first_at >= NOW() - INTERVAL '14 days'
          AND first_at <  NOW() - INTERVAL '7 days'
      )
      SELECT
        (SELECT COUNT(*) FROM cohort_d7)::int AS cohort_size,
        (SELECT COUNT(DISTINCT t.client_seed_fp)
         FROM telemetry_sessions t
         INNER JOIN cohort_d7 c ON t.client_seed_fp = c.client_seed_fp
         WHERE t.received_at >= NOW() - INTERVAL '7 days')::int AS retained
    ` as Array<{ cohort_size: number; retained: number }>;

    // d30 retention: of distinct fingerprints first-seen 30-37 days ago,
    // how many returned in the last 7 days.
    const [retention_d30] = await sql`
      WITH first_seen AS (
        SELECT client_seed_fp, MIN(received_at) AS first_at
        FROM telemetry_sessions
        WHERE client_seed_fp IS NOT NULL
        GROUP BY client_seed_fp
      ),
      cohort_d30 AS (
        SELECT client_seed_fp FROM first_seen
        WHERE first_at >= NOW() - INTERVAL '37 days'
          AND first_at <  NOW() - INTERVAL '30 days'
      )
      SELECT
        (SELECT COUNT(*) FROM cohort_d30)::int AS cohort_size,
        (SELECT COUNT(DISTINCT t.client_seed_fp)
         FROM telemetry_sessions t
         INNER JOIN cohort_d30 c ON t.client_seed_fp = c.client_seed_fp
         WHERE t.received_at >= NOW() - INTERVAL '7 days')::int AS retained
    ` as Array<{ cohort_size: number; retained: number }>;

    c.header("Cache-Control", "no-store");
    return c.json({
      ok: true,
      generated_at: new Date().toISOString(),
      active_users: {
        dau: Number(aggregates?.dau ?? 0),
        wau: Number(aggregates?.wau ?? 0),
        mau: Number(aggregates?.mau ?? 0),
      },
      activity: {
        sessions_24h: Number(aggregates?.sessions_24h ?? 0),
        sessions_7d:  Number(aggregates?.sessions_7d ?? 0),
        tool_calls_7d: Number(aggregates?.tool_calls_7d ?? 0),
      },
      retention: {
        d7:  { cohort_size: retention_d7?.cohort_size ?? 0,  retained: retention_d7?.retained ?? 0 },
        d30: { cohort_size: retention_d30?.cohort_size ?? 0, retained: retention_d30?.retained ?? 0 },
      },
      power_users_7d: Number(aggregates?.power_users_7d ?? 0),
    });
  } catch (err) {
    console.error("[telemetry/retention] query failed:", err instanceof Error ? err.message : String(err));
    return c.json({ error: "query_failed" }, 500);
  }
});

// ============================================================================
// Per-execute telemetry ledger (semantic resolution improvement feed).
// Receives one row per executeEndpoint call: intent, skill_id, endpoint_id,
// outcome, status_code, latency_ms, proxy_used, block_signals.
// Stored in telemetry_executions (Neon Postgres) — same connection pool as
// telemetry_sessions. Falls open (200 ok=true) when DATABASE_URL is absent so
// the client fire-and-forget is never penalised.
// ============================================================================
telemetryRoutes.post("/telemetry/execute", async (c) => {
  const body = await c.req.json<{
    intent?: string;
    skill_id?: string;
    endpoint_id?: string;
    outcome?: string;
    status_code?: number;
    latency_ms?: number;
    proxy_used?: boolean;
    block_signals?: string[];
  }>().catch(() => null);

  if (!body?.skill_id || !body.endpoint_id || !body.outcome) {
    return c.json({ error: "skill_id, endpoint_id, and outcome are required" }, 400);
  }

  c.header("Cache-Control", "no-store");
  c.header("Access-Control-Allow-Origin", "*");

  if (!c.env.DATABASE_URL) {
    // Fall open — don't penalise the client for missing infra.
    return c.json({ ok: true, stored: false, reason: "storage_not_configured" });
  }

  try {
    const sql = await getNeonClient(c.env.DATABASE_URL);
    await sql`
      INSERT INTO telemetry_executions
        (intent, skill_id, endpoint_id, outcome, status_code, latency_ms,
         proxy_used, block_signals, received_at)
      VALUES (
        ${body.intent ?? null},
        ${body.skill_id},
        ${body.endpoint_id},
        ${body.outcome},
        ${body.status_code ?? null},
        ${body.latency_ms ?? null},
        ${body.proxy_used ?? false},
        ${JSON.stringify(body.block_signals ?? [])},
        NOW()
      )
    `;
  } catch (err) {
    // Fall open — telemetry write failure must never break a caller's execute
    // path. Log for ops visibility but return ok=true so fire-and-forget
    // callers don't surface this as an error.
    console.warn(
      "[telemetry/execute] insert failed:",
      err instanceof Error ? err.message : String(err),
    );
    return c.json({ ok: true, stored: false, reason: "insert_failed" });
  }

  return c.json({ ok: true, stored: true });
});
