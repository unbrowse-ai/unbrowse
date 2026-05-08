import { Hono, type Context } from "hono";
import type { Env } from "../types.js";
import { bearerAuth, requireSignedClient } from "../middleware/auth.js";
import { publishSkill, getSkill, getSkillByDomain, listSkillCards, listSkills, updateEndpointScore, updateEndpointSchema, getEndpointSchema } from "../services/marketplace.js";
import { renderSkillMd, renderEmptyDomainMarkdown } from "../services/skillmd.js";
import { listPopularSkills } from "../services/popularity.js";
import { validateSkillManifest } from "../services/validator.js";
import { addSkillDiscovered, getAgent, updateAgentWallet } from "../services/agents.js";
import { rateLimit, agentRateLimit } from "../middleware/rate-limit.js";
import { computeRoutePrice } from "../services/pricing.js";
import { getStats } from "../services/scoring.js";
import { x402Response, verifyX402Proof, buildSkillPaymentTerms, paymentsEnabled, x402UseTestnet } from "../middleware/x402-gate.js";
import { skillsKV } from "../services/kv.js";
import { getAgentWallet, mergeContributor, resolveSkillPaymentRecipient, syncSkillSplitConfig } from "../services/splits.js";
import { getOrSetHttpCache } from "../services/http-cache.js";
import { recordTransaction } from "../services/transactions.js";
import { buildCacheControl, getEdgeCacheJson, putEdgeCacheJson } from "../services/edge-cache.js";
import { verifyEndpointProofsInPlace, summarizeSkillProofs } from "../services/proof-verifier.js";

type SkillRouteEnv = { Bindings: Env; Variables: { agent_id: string; user_id?: string } };

function schedule(c: Context, task: Promise<unknown>): void {
  try {
    (c as Context & { executionCtx: ExecutionContext }).executionCtx.waitUntil(task);
  } catch {
    void task;
  }
}

// Public read routes -- auth required for list, rate-limited
export const publicSkillRoutes = new Hono<SkillRouteEnv>();

// Skills list: card view is public (trimmed payload, edge-cached, safe for homepage).
// Full list still requires auth to prevent unauthenticated 30MB dumps.
publicSkillRoutes.use("/skills", async (c, next) => {
  if (c.req.query("view") === "card") {
    return rateLimit({ limit: 120, window: 60, prefix: "skills-card" })(c, next);
  }
  return bearerAuth(c, async () => {
    await rateLimit({ limit: 60, window: 60, prefix: "skills-list" })(c, next);
  });
});

// GET /v1/skills -- list all
publicSkillRoutes.get("/skills", async (c) => {
  const view = c.req.query("view");
  if (view === "card") {
    const limitRaw = c.req.query("limit");
    const limit = limitRaw ? Number.parseInt(limitRaw, 10) : undefined;
    const includeDeprecated = c.req.query("include_deprecated") === "1";
    const normalizedLimit = Number.isFinite(limit) && (limit as number) > 0 ? limit : undefined;
    const cacheKey = `skills:cards:${includeDeprecated ? "all" : "live"}:${normalizedLimit ?? "all"}`;
    const ttlSeconds = 300;
    const edgeCached = await getEdgeCacheJson<{ skills: Awaited<ReturnType<typeof listSkillCards>> }>(cacheKey);
    if (edgeCached) {
      c.header("Cache-Control", buildCacheControl(ttlSeconds));
      return c.json(edgeCached);
    }
    const payload = await getOrSetHttpCache(c.env, cacheKey, ttlSeconds, async () => ({
      skills: await listSkillCards(c.env, {
        limit: normalizedLimit,
        includeDeprecated,
      }),
    }));
    c.header("Cache-Control", buildCacheControl(ttlSeconds));
    schedule(c, putEdgeCacheJson(cacheKey, payload, ttlSeconds));
    return c.json(payload);
  }

  const skills = await listSkills(c.env);
  return c.json({ skills });
});

// GET /v1/skills/by-domain/:domain/skill.md -- public llms.txt-style export.
// Returns rendered SKILL.md for the most-recent published skill on this domain.
// 200 with markdown if indexed; 200 with "seed me" markdown if not.
publicSkillRoutes.get("/skills/by-domain/:domain/skill.md", async (c) => {
  const raw = c.req.param("domain");
  const domain = decodeURIComponent(raw).toLowerCase();
  if (!domain || !/^[a-z0-9.-]+$/i.test(domain) || !domain.includes(".")) {
    return c.json({ error: "invalid domain" }, 400);
  }
  const cacheKey = `skillmd:domain:${domain}`;
  const cached = await getEdgeCacheJson<{ md: string; indexed: boolean }>(cacheKey);
  if (cached) {
    c.header("Content-Type", "text/markdown; charset=utf-8");
    c.header("Cache-Control", buildCacheControl(120));
    c.header("X-Unbrowse-Indexed", cached.indexed ? "1" : "0");
    return c.body(cached.md);
  }
  const skill = await getSkillByDomain(c.env, domain);
  const md = skill ? renderSkillMd(skill) : renderEmptyDomainMarkdown(domain);
  schedule(c, putEdgeCacheJson(cacheKey, { md, indexed: !!skill }, 120));
  c.header("Content-Type", "text/markdown; charset=utf-8");
  c.header("Cache-Control", buildCacheControl(120));
  c.header("X-Unbrowse-Indexed", skill ? "1" : "0");
  return c.body(md);
});

// GET /v1/skills/popular -- list top skills by observed executions
publicSkillRoutes.get("/skills/popular", async (c) => {
  const limit = parseInt(c.req.query("limit") ?? "8", 10);
  const cacheKey = `skills:popular:${limit}`;
  const ttlSeconds = 300;
  const edgeCached = await getEdgeCacheJson<{ skills: Awaited<ReturnType<typeof listPopularSkills>> }>(cacheKey);
  if (edgeCached) {
    c.header("Cache-Control", buildCacheControl(ttlSeconds));
    c.header("Access-Control-Allow-Origin", "*");
    return c.json(edgeCached);
  }
  const payload = await getOrSetHttpCache(c.env, cacheKey, ttlSeconds, async () => ({
    skills: await listPopularSkills(c.env, limit),
  }));
  c.header("Cache-Control", buildCacheControl(ttlSeconds));
  c.header("Access-Control-Allow-Origin", "*");
  schedule(c, putEdgeCacheJson(cacheKey, payload, ttlSeconds));
  return c.json(payload);
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
    const proof = paymentHeader ?? legacyProofHeader!;
    const { valid, degraded, transaction, settlementHeader } = await verifyX402Proof(proof);
    if (!valid) {
      return c.json({ error: "Payment proof invalid or rejected" }, 403);
    }
    if (degraded) {
      console.warn(`[x402] facilitator down -- allowed degraded access for skill ${skill.skill_id}`);
    }
    if (settlementHeader) {
      c.header("PAYMENT-RESPONSE", settlementHeader);
    }

    // Record to ledger (non-blocking — don't fail the request if ledger write fails)
    const txId = transaction ?? `x402-${Date.now()}-${skill.skill_id.slice(0, 8)}`;
    schedule(c, recordTransaction(c.env, {
      transaction_id: txId,
      consumer_id: c.req.header("Authorization")?.replace("Bearer ", "") ?? "anonymous",
      creator_id: resolveSkillPaymentRecipient(skill, c.env),
      skill_id: skill.skill_id,
      price_usd: priceResult.price_usd,
      payment_proof: proof,
    }).catch((err) => console.warn(`[x402] ledger write failed: ${(err as Error).message}`)));
  }

  // Backfill proof_summary on legacy skills that were stored before this field existed.
  if (!skill.proof_summary) skill.proof_summary = summarizeSkillProofs(skill.endpoints);
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
skillRoutes.post("/skills", bearerAuth, requireSignedClient, async (c) => {
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

  // Validate any proof metadata attached to endpoints. Only independently
  // verified proof systems may be stamped verified/proven; commitment_only is
  // retained as client-side evidence but remains unverified.
  // Hard-reject 422 if any proof is structurally malformed (bad hash, future
  // timestamp) — these are publisher bugs and shouldn't pollute the marketplace.
  // Domain mismatches flow through with verified:false (caveat emptor).
  const skillDomain = typeof body.domain === "string" ? body.domain : "";
  if (skillDomain && Array.isArray(body.endpoints)) {
    const proofResult = verifyEndpointProofsInPlace(
      body.endpoints as Array<{ endpoint_id?: string; zk_proof?: Parameters<typeof verifyEndpointProofsInPlace>[0][number]["zk_proof"] }>,
      skillDomain,
    );
    if (proofResult.malformed.length > 0) {
      return c.json({ error: "Malformed ZK proof", details: proofResult.malformed }, 422);
    }
  }

  let skill;
  const agentId = c.get("agent_id");
  try {
    skill = await publishSkill(c.env, body as Parameters<typeof publishSkill>[1], {
      submitter_agent_id: agentId,
      client_trace_version: c.req.header("X-Unbrowse-Trace-Version") ?? undefined,
      client_code_hash: c.req.header("X-Unbrowse-Code-Hash") ?? undefined,
      client_git_sha: c.req.header("X-Unbrowse-Git-Sha") ?? undefined,
      client_release_manifest: c.req.header("X-Unbrowse-Release-Manifest") ?? undefined,
      client_release_signature: c.req.header("X-Unbrowse-Release-Signature") ?? undefined,
      transport: "cli",
    });
  } catch (err) {
    if ((err as Error).message.startsWith("release_manifest_")) {
      return c.json({ error: (err as Error).message }, 400);
    }
    console.error("[publish] error:", (err as Error).message, (err as Error).stack);
    return c.json({ error: "Failed to publish skill" }, 500);
  }

  // Roll up proof verification status across endpoints. Cheap to compute and
  // gives consumers (frontend cards, agent filters) a one-shot view without
  // walking every endpoint.
  skill.proof_summary = summarizeSkillProofs(skill.endpoints);

  // Track agent contribution and merge into contributors list
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
skillRoutes.patch("/skills/:id", bearerAuth, requireSignedClient, async (c) => {
  const skillId = c.req.param("id");
  if (!skillId) return c.json({ error: "skill id required" }, 400);
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
skillRoutes.patch("/skills/:id/endpoints/:eid", bearerAuth, requireSignedClient, async (c) => {
  const skillId = c.req.param("id");
  const endpointId = c.req.param("eid");
  if (!skillId || !endpointId) return c.json({ error: "skill and endpoint ids required" }, 400);
  const { score, status, response_schema } = await c.req.json<{ score?: number; status?: string; response_schema?: import("../types.js").ResponseSchema }>();
  if (score != null || status) {
    await updateEndpointScore(c.env, skillId, endpointId, score ?? 0, status as any);
  }
  if (response_schema) {
    await updateEndpointSchema(c.env, skillId, endpointId, response_schema);
  }
  return c.json({ ok: true });
});

// POST /v1/skills/:id/endpoints/:eid/annotate — agent contributes best practices
skillRoutes.post("/skills/:id/endpoints/:eid/annotate", bearerAuth, async (c) => {
  const body = await c.req.json<{
    constraints?: Array<{ param: string; rule: string; message: string }>;
    annotations?: Array<{ text: string }>;
  }>();
  const skillId = c.req.param("id");
  const endpointId = c.req.param("eid");
  if (!skillId || !endpointId) return c.json({ error: "skill and endpoint ids required" }, 400);
  const skill = await getSkill(c.env, skillId);
  if (!skill) return c.json({ error: "Skill not found" }, 404);
  const endpoint = skill.endpoints.find((e) => e.endpoint_id === endpointId);
  if (!endpoint) return c.json({ error: "Endpoint not found" }, 404);

  const agentId = c.get("agent_id");
  const now = new Date().toISOString();
  let added = 0;

  if (body.constraints?.length) {
    if (!endpoint.constraints) endpoint.constraints = [];
    for (const c of body.constraints) {
      if (!endpoint.constraints.some((ex) => ex.param === c.param && ex.rule === c.rule)) {
        endpoint.constraints.push({ ...c, source: "agent" as const, learned_at: now } as any);
        added++;
      }
    }
  }

  if (body.annotations?.length) {
    if (!endpoint.annotations) endpoint.annotations = [];
    for (const a of body.annotations) {
      endpoint.annotations.push({ text: a.text, agent_id: agentId, created_at: now });
      added++;
    }
    // Cap at 20 annotations
    if (endpoint.annotations.length > 20) endpoint.annotations = endpoint.annotations.slice(-20);
  }

  if (added > 0) {
    skill.updated_at = now;
    const { skillsKV: getKV } = await import("../services/kv.js");
    await getKV(c.env).put(`skill:${skill.skill_id}`, JSON.stringify(skill));
  }

  return c.json({ ok: true, added });
});
