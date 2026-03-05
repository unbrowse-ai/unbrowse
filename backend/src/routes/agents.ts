import { Hono } from "hono";
import type { Env } from "../types.js";
import { registerAgent, getAgent, listAgents, acceptTos } from "../services/agents.js";
import { recordRegistration } from "../services/analytics.js";
import { bearerAuthNoTos } from "../middleware/auth.js";
import { rateLimit } from "../middleware/rate-limit.js";
import { CURRENT_TOS_VERSION, TOS_SUMMARY } from "../tos.js";

// Public agent routes — no auth required
export const publicAgentRoutes = new Hono<{ Bindings: Env; Variables: { agent_id: string } }>();

// Rate limit: 10 registrations per 5 minutes per IP
publicAgentRoutes.use("/agents/register", rateLimit({ limit: 10, window: 300, prefix: "register" }));

// GET /v1/tos/current — public, returns current ToS version info
publicAgentRoutes.get("/tos/current", (c) => {
  return c.json({
    version: CURRENT_TOS_VERSION,
    summary: TOS_SUMMARY,
    url: "https://unbrowse.ai/terms",
  });
});

// POST /v1/agents/register — self-register and get an API key (requires ToS acceptance)
publicAgentRoutes.post("/agents/register", async (c) => {
  const { name, tos_version } = await c.req.json<{ name: string; tos_version?: string }>();
  if (!name?.trim()) {
    return c.json({ error: "name is required" }, 400);
  }
  if (!tos_version) {
    return c.json({
      error: "tos_acceptance_required",
      message: "You must accept the Terms of Service to register.",
      current_tos_version: CURRENT_TOS_VERSION,
      tos_summary: TOS_SUMMARY,
      tos_url: "https://unbrowse.ai/terms",
    }, 400);
  }
  if (tos_version !== CURRENT_TOS_VERSION) {
    return c.json({
      error: "tos_version_mismatch",
      message: `You accepted ToS version "${tos_version}" but current is "${CURRENT_TOS_VERSION}".`,
      current_tos_version: CURRENT_TOS_VERSION,
    }, 400);
  }
  try {
    const result = await registerAgent(c.env, name, tos_version);
    // Track registration cohort (non-blocking)
    c.executionCtx.waitUntil(recordRegistration(c.env, result.agent_id));
    return c.json(result, 201);
  } catch (err) {
    const msg = (err as Error).message;
    if (msg.includes("already taken")) {
      return c.json({ error: msg }, 409);
    }
    return c.json({ error: msg }, 400);
  }
});

// POST /v1/agents/accept-tos — re-accept updated ToS (uses bearerAuthNoTos to avoid circular block)
publicAgentRoutes.post("/agents/accept-tos", bearerAuthNoTos, async (c) => {
  const agentId = c.get("agent_id");
  if (agentId === "__admin__") {
    return c.json({ ok: true });
  }

  const { tos_version } = await c.req.json<{ tos_version: string }>();
  if (!tos_version || tos_version !== CURRENT_TOS_VERSION) {
    return c.json({
      error: "tos_version_mismatch",
      message: `Expected ToS version "${CURRENT_TOS_VERSION}".`,
      current_tos_version: CURRENT_TOS_VERSION,
    }, 400);
  }

  try {
    await acceptTos(c.env, agentId, tos_version);
    return c.json({ ok: true, tos_accepted_version: tos_version });
  } catch (err) {
    return c.json({ error: (err as Error).message }, 400);
  }
});

// GET /v1/agents/me — authenticated agent's own profile (uses bearerAuthNoTos so agents with outdated ToS can still check their profile)
publicAgentRoutes.get("/agents/me", bearerAuthNoTos, async (c) => {
  const agentId = c.get("agent_id");
  if (agentId === "__admin__") {
    return c.json({ agent_id: "__admin__", name: "admin", created_at: "", skills_discovered: [], total_executions: 0, total_feedback_given: 0, tos_accepted_version: null, tos_accepted_at: null });
  }
  const profile = await getAgent(c.env, agentId);
  if (!profile) {
    return c.json({ error: "Agent profile not found" }, 404);
  }
  return c.json(profile);
});

// GET /v1/agents — list recent agents (public profiles)
publicAgentRoutes.get("/agents", async (c) => {
  const limit = Math.min(Number(c.req.query("limit") ?? 20), 50);
  const agents = await listAgents(c.env, limit);
  return c.json({ agents });
});

// GET /v1/agents/:id — public agent profile
publicAgentRoutes.get("/agents/:id", async (c) => {
  const profile = await getAgent(c.env, c.req.param("id"));
  if (!profile) {
    return c.json({ error: "Agent not found" }, 404);
  }
  return c.json(profile);
});
