import { Hono, type Context } from "hono";
import { mapPublishError } from "./publish-error-map.js";
import type { Env } from "../types.js";
import { bearerAuth, requireSignedClient } from "../middleware/auth.js";
import { publishSkill, getSkill, getSkillByDomain, listSkillCards, listSkills, updateEndpointScore, updateEndpointSchema, getEndpointSchema, invalidateSkillListCaches } from "../services/marketplace.js";
import { reindexSkill, removeSkillFromIndex } from "../services/discovery.js";
import { renderSkillMd, renderEmptyDomainMarkdown } from "../services/skillmd.js";
import { listPopularSkills } from "../services/popularity.js";
import { validateSkillManifest } from "../services/validator.js";
import { addSkillDiscovered, getAgent, updateAgentWallet } from "../services/agents.js";
import { rateLimit, agentRateLimit } from "../middleware/rate-limit.js";
import { computeRoutePrice } from "../services/pricing.js";
import { getStats } from "../services/scoring.js";
import {
  respondWithFlexTerms,
  sponsorAcceptsForPriceUsd,
  handleFlexPaymentAuthorized,
} from "../services/flex-route-helpers.js";
import { skillsKV } from "../services/kv.js";
import { getAgentWallet, mergeContributor, resolveSkillPaymentRecipient, syncSkillSplitConfig } from "../services/splits.js";
import { getOrSetHttpCache } from "../services/http-cache.js";
import { recordTransaction } from "../services/transactions.js";
import { buildCacheControl, getEdgeCacheJson, putEdgeCacheJson } from "../services/edge-cache.js";
import {
  withCache,
  marketplaceCacheKey,
  buildCacheHeaders,
  safeExecutionCtx,
} from "../services/kv-cache.js";
import { verifyEndpointProofsInPlace, summarizeSkillProofs } from "../services/proof-verifier.js";
import { enforcePublishSanitization, detectResidualSecretLeak } from "../services/publish-sanitize.js";
import { aiScrubEndpoints } from "../services/ai-scrub.js";

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

  // W17 marketplace cache wrap. Key = cache:marketplace:<domain> per the
  // spec's namespace convention. TTL=300s with SWR ON — marketplace
  // entries for a domain change on every publish/patch, but publishes
  // are rare relative to lookups; SWR keeps p99 latency low while
  // background-refreshing on the first read after staleness threshold.
  // Domain is a public identifier (lowercased hostname) — no private
  // identifier in the key. Response is the rendered SKILL.md (already
  // public via /v1/skills/by-domain/:domain/skill.md). Matt 6:34.
  //
  // Note: the existing edge-cache (Worker Cache API) layer still fires
  // first; the KV layer is a SECOND tier when edge cache misses (e.g.
  // cold colo, edge cache evicted). Together they form a two-tier
  // discipline: edge-cache for sub-ms hits, RESPONSE_CACHE for
  // cross-colo persistence.
  const edgeCacheKey = `skillmd:domain:${domain}`;
  const edgeCached = await getEdgeCacheJson<{ md: string; indexed: boolean; etag?: string }>(edgeCacheKey);
  if (edgeCached) {
    c.header("Content-Type", "text/markdown; charset=utf-8");
    c.header("Cache-Control", buildCacheControl(120));
    c.header("X-Unbrowse-Indexed", edgeCached.indexed ? "1" : "0");
    c.header("X-Cache", "HIT");
    if (edgeCached.etag) c.header("ETag", `"${edgeCached.etag}"`);
    return c.body(edgeCached.md);
  }

  type SkillMdPayload = { md: string; indexed: boolean };
  const cacheResult = await withCache<SkillMdPayload>(
    c.env,
    marketplaceCacheKey(domain),
    300,
    { staleWhileRevalidate: true, ctx: safeExecutionCtx(c) },
    async () => {
      const skill = await getSkillByDomain(c.env, domain);
      const md = skill ? renderSkillMd(skill) : renderEmptyDomainMarkdown(domain);
      return { md, indexed: !!skill };
    },
  );

  schedule(
    c,
    putEdgeCacheJson(
      edgeCacheKey,
      { ...cacheResult.value, etag: cacheResult.etag },
      120,
    ),
  );

  const cacheHeaders = buildCacheHeaders(cacheResult);
  for (const [k, v] of Object.entries(cacheHeaders)) c.header(k, v);
  c.header("Content-Type", "text/markdown; charset=utf-8");
  c.header("Cache-Control", buildCacheControl(120));
  c.header("X-Unbrowse-Indexed", cacheResult.value.indexed ? "1" : "0");
  return c.body(cacheResult.value.md);
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

// GET /v1/skills/discover -- public intent directory for agents
// Returns top 50 skills (by recency) with machine-readable intent summary,
// required params, and yields so any agent can find capabilities without
// knowing a skill_id. Optional ?intent=<text> filters by substring match.
publicSkillRoutes.get("/skills/discover", async (c) => {
  const intentFilter = (c.req.query("intent") ?? "").trim().toLowerCase();
  const limitRaw = c.req.query("limit");
  const limit = Math.min(
    limitRaw ? Math.max(1, parseInt(limitRaw, 10) || 50) : 50,
    200,
  );

  const cacheKey = `skills:discover:${intentFilter}:${limit}`;
  const ttlSeconds = 300;

  const edgeCached = await getEdgeCacheJson<{ skills: unknown[] }>(cacheKey);
  if (edgeCached) {
    c.header("Cache-Control", buildCacheControl(ttlSeconds));
    c.header("Access-Control-Allow-Origin", "*");
    return c.json(edgeCached);
  }

  const allSkills = await listSkills(c.env);

  // Filter: public, visible, non-suppressed
  const visible = allSkills.filter((skill) => {
    if (skill.visibility === "private") return false;
    const lifecycle = skill.lifecycle;
    if (lifecycle === "deprecated" || lifecycle === "disabled") return false;
    return true;
  });

  // Sort by most recently updated
  visible.sort(
    (a, b) => new Date(b.updated_at).getTime() - new Date(a.updated_at).getTime(),
  );

  // Optional intent filter (substring match on description + intent_signature + intents)
  const filtered = intentFilter
    ? visible.filter((skill) => {
        const haystack = [
          skill.description ?? "",
          skill.intent_signature ?? "",
          ...(skill.intents ?? []),
        ]
          .join(" ")
          .toLowerCase();
        return haystack.includes(intentFilter);
      })
    : visible;

  // Build machine-readable directory rows
  const rows = filtered.slice(0, limit).map((skill) => {
    // Top 3 endpoints by reliability score descending
    const topEndpoints = [...skill.endpoints]
      .sort((a, b) => (b.reliability_score ?? 0) - (a.reliability_score ?? 0))
      .slice(0, 3);

    const top_operations = topEndpoints.map((ep) => {
      // Access extended semantic fields not declared in EndpointDescriptor's type
      const epAny = ep as unknown as Record<string, unknown>;
      const semantic = (epAny["semantic"] ?? {}) as {
        requires?: Array<{ key?: string }>;
        provides?: Array<{ key?: string }>;
      };

      // Extract required_params: prefer semantic binding keys, fall back to URL template {params}
      const semanticRequires: string[] = (semantic.requires ?? [])
        .map((b) => b.key ?? "")
        .filter(Boolean);
      const urlParams: string[] = [
        ...(ep.url_template ?? "").matchAll(/\{([^}]+)\}/g),
      ].map((m) => m[1]);
      const required_params =
        semanticRequires.length > 0 ? semanticRequires : urlParams;

      const yields: string[] = (semantic.provides ?? [])
        .map((b) => b.key ?? "")
        .filter(Boolean);

      return {
        description: (ep.description ?? "").slice(0, 160) || undefined,
        method: ep.method,
        required_params,
        yields,
      };
    });

    // intent_summary: best description from top endpoint, or skill description
    const bestDesc =
      top_operations.find((op) => op.description)?.description ??
      (skill.description ?? "").slice(0, 120);

    return {
      skill_id: skill.skill_id,
      domain: skill.domain,
      intent_summary: bestDesc.slice(0, 120),
      top_operations,
      endpoint_count: skill.endpoints.length,
    };
  });

  const payload = { skills: rows };
  c.header("Cache-Control", buildCacheControl(ttlSeconds));
  c.header("Access-Control-Allow-Origin", "*");
  schedule(c, putEdgeCacheJson(cacheKey, payload, ttlSeconds));
  return c.json(payload);
});

// GET /v1/skills/:id -- get by ID (x402-gated for paid skills)
publicSkillRoutes.get("/skills/:id", async (c) => {
  const skill = await getSkill(c.env, c.req.param("id"));
  if (!skill) return c.json({ error: "Skill not found" }, 404);

  // Private-skill access control (W4-E): private skills are not in the
  // public listing or graph index, but the manifest is still fetchable
  // by skill_id alone. Surface as 404 to non-owners so the URL space
  // doesn't leak which private skill_ids exist. Owner detection runs on
  // the optional bearer key -- anonymous callers always 404 on private.
  if (skill.visibility === "private") {
    const authzHeader = c.req.header("Authorization");
    let callerUserId: string | null = null;
    if (authzHeader?.startsWith("Bearer ")) {
      try {
        const token = authzHeader.slice("Bearer ".length).trim();
        if (!(c.env.API_KEY && token === c.env.API_KEY)) {
          const { verifyLocalKey } = await import("../services/keys.js");
          const { lookupUserIdByKey } = await import("../services/accounts.js");
          const verified = await verifyLocalKey(c.env, token);
          if (verified?.valid && verified.keyId) {
            callerUserId = await lookupUserIdByKey(c.env, verified.keyId).catch(() => null);
          }
        } else {
          // Admin key: allow.
          return c.json(skill);
        }
      } catch {
        // Fall through to 404 below.
      }
    }
    const ownerUserId = (skill as { owner_user_id?: string }).owner_user_id;
    if (!callerUserId || !ownerUserId || callerUserId !== ownerUserId) {
      return c.json({ error: "Skill not found" }, 404);
    }
    // Owner of private skill: skip the x402 payment gate. A user reading
    // their own private skill manifest shouldn't be billed.
    if (!skill.proof_summary) skill.proof_summary = summarizeSkillProofs(skill.endpoints);
    return c.json(skill);
  }

  // Compute dynamic price for this skill
  const statsArr = await Promise.all(
    skill.endpoints.map((ep) => getStats(c.env, skill.skill_id, ep.endpoint_id)),
  );
  const priceResult = computeRoutePrice(skill, statsArr);

  // Indexing-mode-by-default: 402 fires ONLY when the skill owner has
  // explicitly opted in via DNS claim + wallet binding (PR #810). The
  // `priceResult.price_usd > 0` check IS the gate — pricing.ts returns 0
  // unless `owner_compensation_opt_in` is true. No operator-side env-var
  // override (PR #816 removed `PAYMENTS_ENABLED` to eliminate footguns).
  if (priceResult.price_usd > 0) {
    // Subscription admission lane (parallel to x402). If the caller presents a
    // bearer key resolving to an authenticated user with an active subscription,
    // admit without firing x402. F1: when no key or no sub, fall through.
    const authzHeader = c.req.header("Authorization");
    if (authzHeader?.startsWith("Bearer ")) {
      try {
        const token = authzHeader.slice("Bearer ".length).trim();
        if (c.env.API_KEY && token === c.env.API_KEY) {
          c.set("agent_id", "__admin__");
        } else {
          const { verifyLocalKey } = await import("../services/keys.js");
          const { lookupUserIdByKey } = await import("../services/accounts.js");
          const verified = await verifyLocalKey(c.env, token);
          if (verified?.valid && verified.keyId) {
            c.set("agent_id", verified.keyId);
            const uid = await lookupUserIdByKey(c.env, verified.keyId).catch(() => null);
            if (uid) c.set("user_id", uid);
          }
        }
      } catch (err) {
        console.warn("[admission] optional auth lookup failed:", (err as Error).message);
      }
    }

    const { subscriptionAdmits, recordUsage } = await import("../services/stripe.js");
    const admit = await subscriptionAdmits(c.env, c).catch((err) => {
      console.warn("[admission] subscriptionAdmits threw, falling through to x402:", (err as Error).message);
      return { admit: false as const, reason: "no_user" as const };
    });
    const admittedViaSub = admit.admit;
    if (admittedViaSub) {
      if (admit.reason !== "admit_admin" && c.get("user_id")) {
        await recordUsage(c.env, c.get("user_id")!, 1).catch((err) =>
          console.warn("[admission] recordUsage failed (admitted anyway):", (err as Error).message),
        );
      }
      c.header(
        "X-Unbrowse-Billing",
        `${admit.reason === "admit_overage" ? "overage" : admit.reason === "admit_admin" ? "admin" : "subscription"} consumed=${admit.consumed ?? 0}/${admit.quota ?? 0}`,
      );
    }

    if (!admittedViaSub) {
    const flexPaymentHeader = c.req.header("X-PAYMENT");
    const legacyPaymentHeader = c.req.header("PAYMENT-SIGNATURE");
    const legacyProofHeader = c.req.header("X-Payment-Proof");
    let sponsoredAdmit = false;
    let keyFundedAdmit = false;

    if (!flexPaymentHeader && !legacyPaymentHeader && !legacyProofHeader) {
      // No proof provided -- check sponsor tier first, then return 402 with
      // the Flex envelope (v6.16 Phase 1 swap; Corbits envelope was the
      // pre-v6.16 shape and is no longer emitted).
      const recipient = resolveSkillPaymentRecipient(skill, c.env);

      // Sponsor decision: if a valid agent key resolved (above), try to
      // sponsor the first call from the platform wallet. Anonymous callers
      // (no agent_id) skip sponsor and get standard 402.
      const candidateAgentId = c.get("agent_id");
      // P0.3 soft-block: existing v6.15-era agents without complete Flex
      // onboarding get a 402 + X-Flex-Onboarding-Required BEFORE any sponsor
      // or Flex payment terms get processed.
      if (candidateAgentId && candidateAgentId !== "__admin__") {
        const { checkFlexOnboardingOrBlock } = await import("../middleware/flex-onboarding-soft-block.js");
        const blockResp = await checkFlexOnboardingOrBlock(c);
        if (blockResp) return blockResp;
      }

      // L6 (API key wrapping x402): a key bound to a prepaid credit budget
      // auto-pays here via a KV decrement instead of getting a 402, so calls
      // authenticated by that key never need a per-call X-PAYMENT signature.
      // Wallet-bound keys are NOT settled here -- they continue down the Flex
      // facilitator path below exactly as before (on-chain settlement needs
      // the signed envelope, not a KV write).
      if (candidateAgentId && candidateAgentId !== "__admin__") {
        const { getKeyFunding, debitKeyFunding } = await import("../services/keys.js");
        const funding = await getKeyFunding(c.env, candidateAgentId);
        if (funding?.kind === "credit") {
          const priceUc = Math.round(priceResult.price_usd * 1_000_000);
          const debit = await debitKeyFunding(c.env, candidateAgentId, priceUc);
          if (debit.ok) {
            c.header("X-Unbrowse-Billing", `key-credit consumed_uc=${priceUc} remaining_uc=${debit.remaining_uc}`);
            keyFundedAdmit = true;
          }
          // insufficient budget / no binding -> fall through to sponsor + Flex 402.
        }
      }
      if (!keyFundedAdmit && candidateAgentId && candidateAgentId !== "__admin__") {
        const { maybeSponsor } = await import("../middleware/sponsor.js");
        // sponsorAcceptsForPriceUsd builds a minimal accepts[] for the
        // sponsor middleware's debit-side check (it never hits the wire).
        const sponsorAccepts = sponsorAcceptsForPriceUsd(priceResult.price_usd, recipient);
        const decision = await maybeSponsor(c, sponsorAccepts, candidateAgentId);
        if (decision.kind === "sponsored") {
          c.header("X-Sponsored", decision.ledger_id);
          c.header("X-Sponsor-Tx", decision.tx_hash);
          c.header("X-Sponsor-Remaining-Usd", decision.remaining_credit_usd.toFixed(6));
          sponsoredAdmit = true;
          // Fall through, skipping verify block, to serve the skill.
        } else if (decision.kind === "exhausted") {
          c.header("X-Sponsor-Exhausted", "1");
          c.header("X-Sponsor-Reason", decision.reason);
          c.header("X-Sponsor-Remaining-Usd", decision.remaining_credit_usd.toFixed(6));
          return await respondWithFlexTerms(c, {
            skill,
            priceUsd: priceResult.price_usd,
            resource: c.req.url,
            agentId: candidateAgentId,
          });
        } else {
          // opted_out — standard 402 with Flex envelope.
          c.header("X-Sponsor-Reason", "opted_out");
          return await respondWithFlexTerms(c, {
            skill,
            priceUsd: priceResult.price_usd,
            resource: c.req.url,
            agentId: candidateAgentId,
          });
        }
      } else if (!keyFundedAdmit) {
        return await respondWithFlexTerms(c, {
          skill,
          priceUsd: priceResult.price_usd,
          resource: c.req.url,
          agentId: candidateAgentId,
        });
      }
    }

    if (!sponsoredAdmit && !keyFundedAdmit) {
    if (flexPaymentHeader) {
      // Flex authorization carries a signed FlexPaymentPayload — verify
      // via the Flex facilitator, then return the skill body.
      return await handleFlexPaymentAuthorized(c, flexPaymentHeader, {
        executeFn: async () => {
          // Ledger write (best-effort, non-blocking).
          schedule(c, recordTransaction(c.env, {
            transaction_id: `flex-${Date.now()}-${skill.skill_id.slice(0, 8)}`,
            consumer_id: c.req.header("Authorization")?.replace("Bearer ", "") ?? "anonymous",
            creator_id: resolveSkillPaymentRecipient(skill, c.env),
            skill_id: skill.skill_id,
            price_usd: priceResult.price_usd,
            payment_proof: flexPaymentHeader,
          }).catch((err) => console.warn(`[flex] ledger write failed: ${(err as Error).message}`)));
          // W5-B: per-execute Meter event for Metered-tier callers.
          // fireMeterIfMetered is silent for free/Pro/unauth -- only the
          // metered tier enqueues + schedules a background drain.
          await (await import("../services/meter-on-execute.js"))
            .fireMeterIfMetered(c, {
              skill_id: skill.skill_id,
              price_usd: priceResult.price_usd,
              schedule: (task) => schedule(c, task),
            })
            .catch((err) => console.warn(`[meter] fireMeterIfMetered: ${(err as Error).message}`));
          // Backfill proof_summary on legacy skills.
          if (!skill.proof_summary) skill.proof_summary = summarizeSkillProofs(skill.endpoints);
          return new Response(JSON.stringify(skill), {
            status: 200,
            headers: { "content-type": "application/json" },
          });
        },
      });
    }

    // Caller sent only a legacy PAYMENT-SIGNATURE / X-Payment-Proof header.
    // v6.16 Phase 5 removed Corbits verify+settle entirely; emit a fresh
    // Flex 402 so the client re-pays under the new scheme.
    return await respondWithFlexTerms(c, {
      skill,
      priceUsd: priceResult.price_usd,
      resource: c.req.url,
      agentId: c.get("agent_id"),
    });
    }
    }
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
// GET /v1/skills/:id/graph -- return the SkillOperationGraph for DAG introspection.
// Public (no auth) — the graph contains only structural schema, no private data.
// 404 if skill not found; 200 with operation_graph: null if skill exists but has no graph yet.
publicSkillRoutes.get("/skills/:id/graph", async (c) => {
  const skill = await getSkill(c.env, c.req.param("id"));
  if (!skill) return c.json({ error: "Skill not found" }, 404);
  return c.json({
    skill_id: skill.skill_id,
    domain: skill.domain,
    operation_graph: skill.operation_graph ?? null,
  });
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

  // WAVE 1 (SAFETY-CRITICAL): server-authoritative secret sanitization.
  // Client-side sanitizeForPublish is advisory only — a stale or tampered
  // client can skip it and leak the user's OWN secrets (bearer tokens,
  // Cookie headers, api keys, high-entropy blobs, PII) into the PUBLIC
  // marketplace. We re-run the IDENTICAL redaction core here, never trusting
  // the client. Scrub-and-continue is the default (an honest stale client
  // still publishes, just safely); we hard-reject 422 only for structural
  // leakage a scrub cannot neutralize, which signals a malformed/hostile
  // payload. Parity with the client redactor is pinned by
  // backend/tests/sanitize-parity.test.ts.
  if (Array.isArray(body.endpoints)) {
    const { endpoints: scrubbed } = enforcePublishSanitization(body.endpoints);
    const residual = detectResidualSecretLeak(scrubbed);
    if (residual.length > 0) {
      return c.json({
        error: "publish_rejected_residual_secret_leak",
        message:
          "One or more endpoints embed a secret-shaped value in a field the " +
          "sanitizer cannot safely scrub. Re-run client sanitization and remove " +
          "raw credentials before publishing.",
        details: residual,
      }, 422);
    }
    // WAVE 2 (contract 101b1f77): LLM-layer PII scrubber over augmented
    // descriptions/examples. Defense-in-depth above the regex layer —
    // catches real-shaped phone numbers, named-individual prose, "your
    // bearer is ..." sentences whose value escapes the token-shape regex.
    // Soft-fails if NEBIUS_API_KEY is unset (publish proceeds with regex
    // layer only); hard-rejects 422 on any high-confidence LLM leak.
    const ai = await aiScrubEndpoints(scrubbed, c.env);
    if (ai.rejected) {
      return c.json({
        error: "publish_blocked_pii",
        message:
          "LLM scrubber detected residual PII or credential leakage in one or " +
          "more endpoints. Re-run the client sanitizer and remove the flagged " +
          "values before re-publishing.",
        reasons: ai.reasons,
      }, 422);
    }
    body.endpoints = ai.endpoints as unknown[];
    (body as Record<string, unknown>).server_sanitized = true;
    (body as Record<string, unknown>).ai_scrubbed = ai.scrubbed;
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
    const msg = (err as Error).message;
    const mapped = mapPublishError(msg);
    // Only a genuinely unexpected error (the 500 fall-through) is logged with a stack;
    // known refusals are expected control flow and surface their own reason.
    if (mapped.status === 500) console.error("[publish] error:", msg, (err as Error).stack);
    return c.json(mapped.body, mapped.status);
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
  const body = await c.req.json<{ base_price_usd?: number; split_config?: string | null; visibility?: "public" | "private" }>();

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

  let visibilityChangedTo: "public" | "private" | null = null;
  if (body.visibility !== undefined) {
    if (body.visibility !== "public" && body.visibility !== "private") {
      return c.json({ error: "visibility must be 'public' or 'private'" }, 400);
    }
    const prev = skill.visibility ?? "public";
    if (prev !== body.visibility) {
      skill.visibility = body.visibility;
      visibilityChangedTo = body.visibility;
    }
  }

  skill.updated_at = new Date().toISOString();
  const kv = skillsKV(c.env);
  await kv.put(`skill:${skillId}`, JSON.stringify(skill));

  // Visibility toggles graph-index membership via the same primitives the
  // publish path uses, so resolve/search stays consistent without a
  // per-call private filter. Card list cache is dropped so the public
  // homepage reflects the change immediately.
  if (visibilityChangedTo === "private") {
    await removeSkillFromIndex(c.env, skill.skill_id, skill.domain).catch((err) =>
      console.warn(`[skills] removeSkillFromIndex failed for ${skill.skill_id}:`, (err as Error).message),
    );
    await invalidateSkillListCaches(c.env).catch(() => {});
  } else if (visibilityChangedTo === "public") {
    await reindexSkill(c.env, skill).catch((err) =>
      console.warn(`[skills] reindexSkill failed for ${skill.skill_id}:`, (err as Error).message),
    );
    await invalidateSkillListCaches(c.env).catch(() => {});
  }

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

// POST /v1/skills/by-domain/:domain/verify/challenge — request a domain verification token
//
// SECURITY: the publisher must demonstrate control of the DNS hostname before
// the marketplace stamps `domain_verified: true`. We issue a single-use token,
// the publisher serves it at /.well-known/<token> on their domain, and
// /probe (below) fetches and matches the body. The token is bound to the
// requesting agent_id so a different agent's probe call won't succeed against
// someone else's challenge.
skillRoutes.post("/skills/by-domain/:domain/verify/challenge", bearerAuth, async (c) => {
  const domainParam = decodeURIComponent(c.req.param("domain") ?? "").toLowerCase();
  if (!domainParam || !/^[a-z0-9.-]+$/.test(domainParam) || !domainParam.includes(".")) {
    return c.json({ error: "invalid_domain" }, 400);
  }
  const { issueDomainChallenge } = await import("../services/domain-verifier.js");
  const challenge = await issueDomainChallenge(c.env, domainParam, c.get("agent_id"));
  return c.json({
    domain: challenge.domain,
    token: challenge.token,
    path: challenge.path,
    expected_url: challenge.expected_url,
    body: challenge.body,
    expires_at: challenge.expires_at,
    instructions: `Serve the body string at ${challenge.expected_url} (text/plain). Then POST /v1/skills/by-domain/${challenge.domain}/verify/probe.`,
  });
});

// POST /v1/skills/by-domain/:domain/verify/probe — run the .well-known probe
skillRoutes.post("/skills/by-domain/:domain/verify/probe", bearerAuth, async (c) => {
  const domainParam = decodeURIComponent(c.req.param("domain") ?? "").toLowerCase();
  if (!domainParam || !/^[a-z0-9.-]+$/.test(domainParam) || !domainParam.includes(".")) {
    return c.json({ error: "invalid_domain" }, 400);
  }
  const { loadDomainChallenge, probeDomain, markDomainVerified, clearDomainChallenge } =
    await import("../services/domain-verifier.js");
  const challenge = await loadDomainChallenge(c.env, domainParam);
  if (!challenge) {
    return c.json({
      error: "no_challenge",
      message: "No active challenge for this domain. POST .../verify/challenge first.",
    }, 404);
  }
  const callerAgentId = c.get("agent_id");
  if (challenge.agent_id !== callerAgentId && callerAgentId !== "__admin__") {
    return c.json({
      error: "challenge_owner_mismatch",
      message: "This challenge was issued to a different agent.",
    }, 403);
  }

  const result = await probeDomain(c.env, challenge);
  if (!result.ok) {
    return c.json({
      ok: false,
      reason: result.reason,
      detail: result.detail,
      status: result.status,
      expected_url: challenge.expected_url,
    }, 400);
  }

  const stamped = await markDomainVerified(c.env, domainParam);
  if (!stamped) {
    // Probe succeeded but no skill exists yet for this domain — keep the
    // challenge alive so the publisher can publish + re-probe in one move.
    return c.json({
      ok: true,
      verified: false,
      message: "Probe succeeded but no published skill found for this domain yet. Publish first, then re-run probe.",
    });
  }
  await clearDomainChallenge(c.env, domainParam);
  return c.json({
    ok: true,
    verified: true,
    domain: domainParam,
    verified_at: new Date().toISOString(),
  });
});
