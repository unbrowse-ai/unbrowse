import { Hono } from "hono";
import type { Env } from "../types.js";
import { publishSkill, getSkill, listSkills, updateEndpointScore, getEndpointSchema } from "../services/marketplace.js";
import { validateSkillManifest } from "../services/validator.js";

export const skillRoutes = new Hono<{ Bindings: Env }>();

// POST /v1/skills — publish/update
skillRoutes.post("/skills", async (c) => {
  const body = await c.req.json();
  const validation = validateSkillManifest(body);
  if (!validation.valid) {
    return c.json({ error: "Validation failed", details: validation.hardErrors }, 422);
  }
  const skill = await publishSkill(c.env, body);
  return c.json({
    skill_id: skill.skill_id,
    version: skill.version,
    warnings: validation.softWarnings,
  }, 201);
});

// GET /v1/skills — list all
skillRoutes.get("/skills", async (c) => {
  const skills = await listSkills(c.env);
  return c.json({ skills });
});

// GET /v1/skills/:id — get by ID
skillRoutes.get("/skills/:id", async (c) => {
  const skill = await getSkill(c.env, c.req.param("id"));
  if (!skill) return c.json({ error: "Skill not found" }, 404);
  return c.json(skill);
});

// PATCH /v1/skills/:id/endpoints/:eid — update endpoint score/status
skillRoutes.patch("/skills/:id/endpoints/:eid", async (c) => {
  const { score, status } = await c.req.json<{ score: number; status?: string }>();
  await updateEndpointScore(c.env, c.req.param("id"), c.req.param("eid"), score, status as any);
  return c.json({ ok: true });
});

// GET /v1/skills/:id/endpoints/:eid/schema — get response schema
skillRoutes.get("/skills/:id/endpoints/:eid/schema", async (c) => {
  const schema = await getEndpointSchema(c.env, c.req.param("id"), c.req.param("eid"));
  if (!schema) return c.json({ error: "No schema available" }, 404);
  return c.json(schema);
});
