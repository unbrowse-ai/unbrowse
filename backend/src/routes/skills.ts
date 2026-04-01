import { Hono } from "hono";
import type { Env } from "../types.js";
import { publishSkill, getSkill, listSkills, updateEndpointScore, updateEndpointSchema, getEndpointSchema } from "../services/marketplace.js";
import { validateSkillManifest } from "../services/validator.js";
import { addSkillDiscovered } from "../services/agents.js";
import { rateLimit, agentRateLimit } from "../middleware/rate-limit.js";
import { computeRoutePrice } from "../services/pricing.js";
import { getStats } from "../services/scoring.js";
import { x402Response, verifyX402Proof, buildSkillPaymentTerms } from "../middleware/x402-gate.js";

// Public read routes — no auth required
export const publicSkillRoutes = new Hono<{ Bindings: Env }>();

// Rate limit: 10 list requests per 60s, 30 individual skill reads per 60s
publicSkillRoutes.use("/skills", rateLimit({ limit: 60, window: 60, prefix: "skills-list" }));

// GET /v1/skills — list all
publicSkillRoutes.get("/skills", async (c) => {
  const skills = await listSkills(c.env);
  return c.json({ skills });
});

// GET /v1/skills/:id — get by ID (x402-gated for paid skills)
publicSkillRoutes.get("/skills/:id", async (c) => {
  const skill = await getSkill(c.env, c.req.param("id"));
  if (!skill) return c.json({ error: "Skill not found" }, 404);

  // Compute dynamic price for this skill
  const statsArr = await Promise.all(
    skill.endpoints.map((ep) => getStats(c.env, skill.skill_id, ep.endpoint_id)),
  );
  const priceResult = computeRoutePrice(skill, statsArr);

  // Free skills (price=0 or below floor) skip the gate
  if (priceResult.price_usd > 0) {
    const proofHeader = c.req.header("X-Payment-Proof");

    if (!proofHeader) {
      // No proof provided — return 402 with payment terms
      const recipient = c.env.PAYMENT_RECIPIENT ?? "0x0000000000000000000000000000000000000000";
      const resource = new URL(c.req.url).pathname;
      const terms = buildSkillPaymentTerms(
        priceResult.price_usd,
        skill.skill_id,
        recipient,
        resource,
      );
      return x402Response(c, terms);
    }

    // Proof provided — verify via Corbits facilitator
    const { valid, degraded } = await verifyX402Proof(proofHeader);
    if (!valid) {
      return c.json({ error: "Payment proof invalid or rejected" }, 403);
    }
    if (degraded) {
      console.warn(`[x402] facilitator down — allowed degraded access for skill ${skill.skill_id}`);
    }
  }

  return c.json(skill);
});

// GET /v1/skills/:id/endpoints/:eid/schema — get response schema
publicSkillRoutes.get("/skills/:id/endpoints/:eid/schema", async (c) => {
  const schema = await getEndpointSchema(c.env, c.req.param("id"), c.req.param("eid"));
  if (!schema) return c.json({ error: "No schema available" }, 404);
  return c.json(schema);
});

// GET /v1/skills/:id/price — dynamic route price + site-owner compensation info
publicSkillRoutes.get("/skills/:id/price", async (c) => {
  const skill = await getSkill(c.env, c.req.param("id"));
  if (!skill) return c.json({ error: "Skill not found" }, 404);
  // Load per-endpoint stats in parallel
  const statsArr = await Promise.all(
    skill.endpoints.map((ep) => getStats(c.env, skill.skill_id, ep.endpoint_id)),
  );
  const price = computeRoutePrice(skill, statsArr);
  return c.json(price);
});

// Protected write routes — auth required
export const skillRoutes = new Hono<{ Bindings: Env; Variables: { agent_id: string } }>();

// Rate limit: 30 publishes per 60s per agent
skillRoutes.use("/skills", agentRateLimit({ limit: 30, window: 60, prefix: "publish" }));
// Rate limit: 60 endpoint updates per 60s per agent
skillRoutes.use("/skills/:id/endpoints/:eid", agentRateLimit({ limit: 60, window: 60, prefix: "ep-update" }));

// POST /v1/skills — publish/update
skillRoutes.post("/skills", async (c) => {
  const body = await c.req.json();
  const validation = validateSkillManifest(body);
  if (!validation.valid) {
    return c.json({ error: "Validation failed", details: validation.hardErrors }, 422);
  }
  let skill;
  try {
    skill = await publishSkill(c.env, body);
  } catch (err) {
    console.error("[publish] error:", (err as Error).message, (err as Error).stack);
    return c.json({ error: "Publish failed", detail: (err as Error).message }, 500);
  }
  // Track agent contribution (non-blocking)
  const agentId = c.get("agent_id");
  if (agentId) {
    c.executionCtx.waitUntil(addSkillDiscovered(c.env, agentId, skill.skill_id));
  }
  // Return the full manifest so clients don't need a read-after-write round-trip
  return c.json({
    ...skill,
    warnings: validation.softWarnings,
  }, 201);
});

// PATCH /v1/skills/:id/endpoints/:eid — update endpoint score/status/schema
skillRoutes.patch("/skills/:id/endpoints/:eid", async (c) => {
  const { score, status, response_schema } = await c.req.json<{ score?: number; status?: string; response_schema?: import("../types.js").ResponseSchema }>();
  if (score != null || status) {
    await updateEndpointScore(c.env, c.req.param("id"), c.req.param("eid"), score ?? 0, status as any);
  }
  if (response_schema) {
    await updateEndpointSchema(c.env, c.req.param("id"), c.req.param("eid"), response_schema);
  }
  return c.json({ ok: true });
});
