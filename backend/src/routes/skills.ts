import { Hono } from "hono";
import type { Env } from "../types.js";
import { bearerAuth } from "../middleware/auth.js";
import { publishSkill, getSkill, listSkills, updateEndpointScore, updateEndpointSchema, getEndpointSchema } from "../services/marketplace.js";
import { listPopularSkills } from "../services/popularity.js";
import { validateSkillManifest } from "../services/validator.js";
import { addSkillDiscovered, getAgent, updateAgentWallet } from "../services/agents.js";
import { rateLimit, agentRateLimit } from "../middleware/rate-limit.js";
import { computeRoutePrice } from "../services/pricing.js";
import { getStats } from "../services/scoring.js";
import { x402Response, verifyX402Proof, buildSkillPaymentTerms, paymentsEnabled, x402UseTestnet } from "../middleware/x402-gate.js";
import { skillsKV } from "../services/kv.js";
import { getAgentWallet, mergeContributor, resolveSkillPaymentRecipient, syncSkillSplitConfig } from "../services/splits.js";

// Public read routes -- no auth required
export const publicSkillRoutes = new Hono<{ Bindings: Env }>();

// Rate limit: 10 list requests per 60s, 30 individual skill reads per 60s
publicSkillRoutes.use("/skills", rateLimit({ limit: 60, window: 60, prefix: "skills-list" }));

// GET /v1/skills -- list all
publicSkillRoutes.get("/skills", async (c) => {
  const skills = await listSkills(c.env);
  return c.json({ skills });
});
// GET /v1/skills/popular -- list top skills by observed executions
publicSkillRoutes.get("/skills/popular", async (c) => {
  const limit = parseInt(c.req.query("limit") ?? "8", 10);
  const skills = await listPopularSkills(c.env, limit);
  c.header("Cache-Control", "public, max-age=60");
  c.header("Access-Control-Allow-Origin", "*");
  return c.json({ skills });
});
// GET /v1/skills/:id -- get by ID (x402-gated for paid skills)
publicSkillRoutes.get("/skills/:id", async (c) => {
  const skill = await getSkill(c.env, c.req.param("id"));
  if (!skill) return c.json({ error: "Skill not found" }, 404);

  // Compute dynamic price for this skill
  const statsArr = await Promise.all(
    skill.endpoints.map((ep) => getStats(c.env, skill.skill_id, ep.endpoint_id)),
  );
  const priceResult = computeRoutePrice(skill, statsArr);

  // Free skills (price=0 or below floor) skip the gate
  if (priceResult.price_usd > 0 && paymentsEnabled(c.env)) {
    const paymentHeader = c.req.header("PAYMENT-SIGNATURE");
    const legacyProofHeader = c.req.header("X-Payment-Proof");

    if (!paymentHeader && !legacyProofHeader) {
      // No proof provided -- return 402 with payment terms
      const recipient = resolveSkillPaymentRecipient(skill, c.env);
      const terms = await buildSkillPaymentTerms(
        priceResult.price_usd,
        skill.skill_id,
        recipient,
        c.req.url,
        { testnet: x402UseTestnet(c.env) },
      );
      return x402Response(c, terms);
    }

    // Proof provided -- verify via Corbits facilitator
    const { valid, degraded, settlementHeader } = await verifyX402Proof(paymentHeader ?? legacyProofHeader!);
    if (!valid) {
      return c.json({ error: "Payment proof invalid or rejected" }, 403);
    }
    if (degraded) {
      console.warn(`[x402] facilitator down -- allowed degraded access for skill ${skill.skill_id}`);
    }
    if (settlementHeader) {
      c.header("PAYMENT-RESPONSE", settlementHeader);
    }
  }

  return c.json(skill);
});

// GET /v1/skills/:id/endpoints/:eid/schema -- get response schema
publicSkillRoutes.get("/skills/:id/endpoints/:eid/schema", async (c) => {
  const schema = await getEndpointSchema(c.env, c.req.param("id"), c.req.param("eid"));
  if (!schema) return c.json({ error: "No schema available" }, 404);
  return c.json(schema);
});

// GET /v1/skills/:id/price -- dynamic route price + site-owner compensation info
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
// Protected write routes -- auth required
export const skillRoutes = new Hono<{ Bindings: Env; Variables: { agent_id: string } }>();

// Rate limit: 30 publishes per 60s per agent
skillRoutes.use("/skills", agentRateLimit({ limit: 30, window: 60, prefix: "publish" }));
// Rate limit: 60 endpoint updates per 60s per agent
skillRoutes.use("/skills/:id/endpoints/:eid", agentRateLimit({ limit: 60, window: 60, prefix: "ep-update" }));

// POST /v1/skills -- publish/update
skillRoutes.post("/skills", bearerAuth, async (c) => {
  const body = await c.req.json<Record<string, unknown> & {
    indexer_id?: string;
    endpoints?: unknown[];
    wallet_address?: string;
    wallet_provider?: string;
  }>();
  const validation = validateSkillManifest(body);
  if (!validation.valid) {
    return c.json({ error: "Validation failed", details: validation.hardErrors }, 422);
  }
  let skill;
  try {
    skill = await publishSkill(c.env, body as Parameters<typeof publishSkill>[1]);
  } catch (err) {
    console.error("[publish] error:", (err as Error).message, (err as Error).stack);
    return c.json({ error: "Failed to publish skill" }, 500);
  }

  // Track agent contribution and merge into contributors list
  const agentId = c.get("agent_id");
  if (agentId) {
    try {
      c.executionCtx.waitUntil(addSkillDiscovered(c.env, agentId, skill.skill_id));
    } catch {
      void addSkillDiscovered(c.env, agentId, skill.skill_id);
    }

    // Merge this agent as a contributor with their endpoint count
    const indexerId = body.indexer_id ?? agentId;
    const endpointsAdded = body.endpoints?.length ?? 0;
    const existing = await getSkill(c.env, skill.skill_id);
    const publishWalletAddress = typeof body.wallet_address === "string" ? body.wallet_address.trim() : undefined;
    const publishWalletProvider = typeof body.wallet_provider === "string" ? body.wallet_provider.trim() : undefined;
    let profile = await getAgent(c.env, indexerId);
    if (indexerId === agentId && publishWalletAddress) {
      try {
        profile = (await updateAgentWallet(c.env, agentId, {
          wallet_address: publishWalletAddress,
          wallet_provider: publishWalletProvider,
        })).profile;
      } catch (err) {
        console.warn(`[publish] wallet sync skipped for ${agentId}: ${(err as Error).message}`);
      }
    }
    const wallet = getAgentWallet(profile) as { wallet_address?: string };
    const contributors = mergeContributor(
      existing?.contributors ?? [],
      indexerId,
      endpointsAdded,
      wallet.wallet_address,
    );
    // Persist updated contributors
    const kv = skillsKV(c.env);
    const updated = syncSkillSplitConfig({ ...skill, contributors });
    await kv.put(`skill:${skill.skill_id}`, JSON.stringify(updated));
    skill = updated;
  }

  // Return the full manifest so clients don't need a read-after-write round-trip
  return c.json({
    ...skill,
    warnings: validation.softWarnings,
  }, 201);
});

// PATCH /v1/skills/:id -- update skill metadata (e.g. base_price_usd)
skillRoutes.patch("/skills/:id", bearerAuth, async (c) => {
  const skillId = c.req.param("id");
  const body = await c.req.json<{ base_price_usd?: number; split_config?: string | null }>();

  const skill = await getSkill(c.env, skillId);
  if (!skill) return c.json({ error: "Skill not found" }, 404);

  // Validate base_price_usd if provided
  if (body.base_price_usd !== undefined) {
    if (typeof body.base_price_usd !== "number" || body.base_price_usd < 0) {
      return c.json({ error: "base_price_usd must be a non-negative number" }, 400);
    }
    skill.base_price_usd = body.base_price_usd;
  }

  if (body.split_config !== undefined) {
    const splitConfig = body.split_config?.trim();
    if (body.split_config !== null && !splitConfig) {
      return c.json({ error: "split_config must be a non-empty string or null" }, 400);
    }
    if (splitConfig) skill.split_config = splitConfig;
    else delete skill.split_config;
  }

  skill.updated_at = new Date().toISOString();
  const kv = skillsKV(c.env);
  await kv.put(`skill:${skillId}`, JSON.stringify(skill));
  return c.json(skill);
});

// PATCH /v1/skills/:id/endpoints/:eid -- update endpoint score/status/schema
skillRoutes.patch("/skills/:id/endpoints/:eid", bearerAuth, async (c) => {
  const { score, status, response_schema } = await c.req.json<{ score?: number; status?: string; response_schema?: import("../types.js").ResponseSchema }>();
  if (score != null || status) {
    await updateEndpointScore(c.env, c.req.param("id"), c.req.param("eid"), score ?? 0, status as any);
  }
  if (response_schema) {
    await updateEndpointSchema(c.env, c.req.param("id"), c.req.param("eid"), response_schema);
  }
  return c.json({ ok: true });
});
