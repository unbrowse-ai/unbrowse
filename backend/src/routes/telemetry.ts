import { Hono } from "hono";
import type { Env, FunnelEventName, FunnelEventSource, WebTelemetryEventName } from "../types.js";
import { optionalAuth } from "../middleware/auth.js";
import { recordFunnelEvent } from "../services/funnel.js";
import { recordInstallTelemetry } from "../services/install-telemetry.js";
import { recordWebTelemetry } from "../services/acquisition.js";

export const telemetryRoutes = new Hono<{ Bindings: Env; Variables: { agent_id: string } }>();

telemetryRoutes.use("/telemetry/events", optionalAuth);
telemetryRoutes.use("/telemetry/install", optionalAuth);

telemetryRoutes.post("/telemetry/events", async (c) => {
  const body = await c.req.json<{
    install_id?: string;
    session_id?: string;
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
  const stored = await recordFunnelEvent(c.env, {
    install_id: body.install_id,
    session_id: body.session_id,
    name: body.name,
    source: body.source,
    host_type: body.host_type,
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
  const stored = await recordInstallTelemetry(c.env, {
    install_id: body.install_id,
    source: body.source,
    host_type: body.host_type,
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
    path: body.path,
    referrer: body.referrer,
    created_at: body.created_at,
    properties: body.properties,
  });

  c.header("Cache-Control", "no-store");
  c.header("Access-Control-Allow-Origin", "*");
  return c.json({ ok: true, event_id: stored.event_id });
});
