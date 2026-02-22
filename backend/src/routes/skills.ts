import { Hono } from "hono";
import type { Env } from "../types.js";
import { publishSkill, getSkill, listSkills, updateEndpointScore, getEndpointSchema } from "../services/marketplace.js";
import { validateSkillManifest } from "../services/validator.js";
import { addSkillDiscovered } from "../services/agents.js";
import { rateLimit } from "../middleware/rate-limit.js";

// Public read routes — no auth required
export const publicSkillRoutes = new Hono<{ Bindings: Env }>();

// Rate limit: 10 list requests per 60s, 30 individual skill reads per 60s
publicSkillRoutes.use("/skills", rateLimit({ limit: 10, window: 60, prefix: "skills-list" }));

// GET /v1/skills — list all
publicSkillRoutes.get("/skills", async (c) => {
  const skills = await listSkills(c.env);
  return c.json({ skills });
});

// GET /v1/skills/:id — get by ID
publicSkillRoutes.get("/skills/:id", async (c) => {
  const skill = await getSkill(c.env, c.req.param("id"));
  if (!skill) return c.json({ error: "Skill not found" }, 404);
  return c.json(skill);
});

// GET /v1/skills/:id/endpoints/:eid/schema — get response schema
publicSkillRoutes.get("/skills/:id/endpoints/:eid/schema", async (c) => {
  const schema = await getEndpointSchema(c.env, c.req.param("id"), c.req.param("eid"));
  if (!schema) return c.json({ error: "No schema available" }, 404);
  return c.json(schema);
});

// Protected write routes — auth required
export const skillRoutes = new Hono<{ Bindings: Env; Variables: { agent_id: string } }>();

// POST /v1/skills — publish/update
skillRoutes.post("/skills", async (c) => {
  const body = await c.req.json();
  const validation = validateSkillManifest(body);
  if (!validation.valid) {
    return c.json({ error: "Validation failed", details: validation.hardErrors }, 422);
  }
  const skill = await publishSkill(c.env, body);
  // Track agent contribution (non-blocking)
  const agentId = c.get("agent_id");
  if (agentId) {
    c.executionCtx.waitUntil(addSkillDiscovered(c.env, agentId, skill.skill_id));
  }
  return c.json({
    skill_id: skill.skill_id,
    version: skill.version,
    warnings: validation.softWarnings,
  }, 201);
});

// PATCH /v1/skills/:id/endpoints/:eid — update endpoint score/status
skillRoutes.patch("/skills/:id/endpoints/:eid", async (c) => {
  const { score, status } = await c.req.json<{ score: number; status?: string }>();
  await updateEndpointScore(c.env, c.req.param("id"), c.req.param("eid"), score, status as any);
  return c.json({ ok: true });
});
