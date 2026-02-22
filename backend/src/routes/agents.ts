import { Hono } from "hono";
import type { Env } from "../types.js";
import { registerAgent, getAgent, listAgents } from "../services/agents.js";
import { bearerAuth } from "../middleware/auth.js";
import { rateLimit } from "../middleware/rate-limit.js";

// Public agent routes — no auth required
export const publicAgentRoutes = new Hono<{ Bindings: Env; Variables: { agent_id: string } }>();

// Rate limit: 3 registrations per 5 minutes per IP
publicAgentRoutes.use("/agents/register", rateLimit({ limit: 10, window: 300, prefix: "register" }));

// POST /v1/agents/register — self-register and get an API key
publicAgentRoutes.post("/agents/register", async (c) => {
  const { name } = await c.req.json<{ name: string }>();
  if (!name?.trim()) {
    return c.json({ error: "name is required" }, 400);
  }
  try {
    const result = await registerAgent(c.env, name);
    return c.json(result, 201);
  } catch (err) {
    const msg = (err as Error).message;
    if (msg.includes("already taken")) {
      return c.json({ error: msg }, 409);
    }
    return c.json({ error: msg }, 400);
  }
});

// GET /v1/agents/me — authenticated agent's own profile (must be before /:id)
publicAgentRoutes.get("/agents/me", bearerAuth, async (c) => {
  const agentId = c.get("agent_id");
  if (agentId === "__admin__") {
    return c.json({ agent_id: "__admin__", name: "admin", created_at: "", skills_discovered: [], total_executions: 0, total_feedback_given: 0 });
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
