import { Hono, type Context, type Next } from "hono";
import type { Env } from "../types.js";
import { searchIntent, searchIntentInDomain, searchIntentResolve, searchEndpoints, type EndpointSearchHit } from "../services/discovery.js";
import { webSearch } from "../services/web-search/index.js";
import { getOrComputeSemantic } from "../services/semantic-cache.js";
import { rateLimit } from "../middleware/rate-limit.js";
import { indexContributorAuth, requireSignedClient, optionalAuth } from "../middleware/auth.js";
import { GRAPH_OPERATION_COST_UC, recordGraphFee } from "../services/fees.js";
import {
  respondWithFlexTerms,
  sponsorAcceptsForPriceUsd,
  handleFlexPaymentAuthorized,
} from "../services/flex-route-helpers.js";
import { getOrSetHttpCache } from "../services/http-cache.js";
import { recordTransaction } from "../services/transactions.js";
import { buildCacheControl, getEdgeCacheJson, putEdgeCacheJson } from "../services/edge-cache.js";
import { rankEndpointsServer, type RankRequest } from "../services/rank.js";
import { orderResolvedResults } from "../services/bible-anchor.js";
import {
  withCache,
  resolveCacheKey,
  buildCacheHeaders,
  CacheNotModified,
  safeExecutionCtx,
} from "../services/kv-cache.js";

/**
 * Public discovery: the website's anonymous skill search must work without an
 * API key (North Star: public discovery drives installs). When a key IS
 * presented (an agent), keep the signed-client anti-abuse gate. Anonymous
 * callers get public card-tier results only -- private skills are already
 * out of the graph index (visibility toggle), so this never leaks them.
 */
async function signedClientIfAuthed(c: Context<{ Bindings: Env; Variables: { agent_id: string; user_id?: string } }>, next: Next) {
  if (c.get("agent_id")) {
    return requireSignedClient(c, next);
  }
  await next();
}
function schedule<T, E extends { Bindings: Env }>(c: Context<E>, task: Promise<T>): void {
  try {
    c.executionCtx.waitUntil(task);
  } catch {
    void task;
  }
}


function chargeSearchFee(env: Env, agentId: string): void {
  recordGraphFee(env, agentId, "search").catch(() => {});
}

function shouldRequireSearchPayment(_env: Env): boolean {
  // PR #816: search is ALWAYS free indexing. The previous env-var
  // escape hatches (`PAYMENTS_ENABLED` + `X402_SEARCH_ENABLED`) are
  // gone — no operator-side knob can flip search into paid mode. The
  // function is kept (rather than inlined to `false`) so the cache /
  // payment-fee call sites still read meaningfully and future per-query
  // pricing (if ever revisited as a per-skill opt-in) has a single hook.
  return false;
}

function normalizeSearchText(value: string | undefined): string {
  return (value ?? "").trim().toLowerCase().replace(/\s+/g, " ");
}

function shouldCacheSearch<E extends { Bindings: Env }>(c: Context<E>): boolean {
  return !shouldRequireSearchPayment(c.env);
}

async function getCachedSearchPayload<T, E extends { Bindings: Env }>(
  c: Context<E>,
  key: string,
  ttlSeconds: number,
  load: () => Promise<T>,
): Promise<T> {
  const edgeCached = await getEdgeCacheJson<T>(key);
  if (edgeCached) return edgeCached;
  const payload = await getOrSetHttpCache(c.env, key, ttlSeconds, load);
  schedule(c, putEdgeCacheJson(key, payload, ttlSeconds));
  return payload;
}

function setSearchCacheHeaders<E extends { Bindings: Env }>(c: Context<E>, ttlSeconds: number): void {
  c.header("Cache-Control", buildCacheControl(ttlSeconds));
}

async function requireSearchPayment<E extends { Bindings: Env }>(
  c: Context<E>,
  routeLabel: string,
): Promise<Response | null> {
  if (!shouldRequireSearchPayment(c.env)) return null;
  return runPricedSearchGate(c, routeLabel, GRAPH_OPERATION_COST_UC.search / 1_000_000);
}

/**
 * The priced search/x402 gate: subscription admit → sponsor → 402 Flex terms →
 * verify+settle. Factored out so it can be reused at a different price. The
 * (currently free) local `/search` calls it only when payment is enabled; the
 * `/search/web` external web search calls it ALWAYS for non-owner callers, since
 * the web round-trip has a real cost. Returns a Response to short-circuit (402 /
 * onboarding), or null to admit.
 */
async function runPricedSearchGate<E extends { Bindings: Env }>(
  c: Context<E>,
  routeLabel: string,
  priceUsd: number,
): Promise<Response | null> {
  // Subscription admission lane (parallel to x402). If the caller's bearer key
  // resolves to a user with an active subscription, admit. F1: no user / no
  // sub falls through to x402 below.
  const { subscriptionAdmits, recordUsage } = await import("../services/stripe.js");
  const admit = await subscriptionAdmits(
    c.env,
    c as unknown as Parameters<typeof subscriptionAdmits>[1],
  ).catch((err) => {
    console.warn("[admission] subscriptionAdmits threw, falling through to x402:", (err as Error).message);
    return { admit: false as const, reason: "no_user" as const };
  });
  if (admit.admit) {
    const uid = (c as unknown as { get: (k: string) => string | undefined }).get("user_id");
    if (admit.reason !== "admit_admin" && uid) {
      await recordUsage(c.env, uid, 1).catch((err) =>
        console.warn("[admission] recordUsage failed (admitted anyway):", (err as Error).message),
      );
    }
    c.header(
      "X-Unbrowse-Billing",
      `${admit.reason === "admit_overage" ? "overage" : admit.reason === "admit_admin" ? "admin" : "subscription"} consumed=${admit.consumed ?? 0}/${admit.quota ?? 0}`,
    );
    return null;
  }

  const flexPaymentHeader = c.req.header("X-PAYMENT");
  const legacyPaymentHeader = c.req.header("PAYMENT-SIGNATURE");
  const legacyProofHeader = c.req.header("X-Payment-Proof");

  // Synthetic skill descriptor for the Flex envelope. Search isn't backed by
  // a SkillManifest; recipient is the platform wallet. priceUsd is a parameter.
  const skillId = `graph-search:${routeLabel}`;
  const searchRecipient = c.env.PAYMENT_RECIPIENT ?? "0x0000000000000000000000000000000000000000";
  const searchSkill = {
    skill_id: skillId,
    contributors: c.env.PAYMENT_RECIPIENT
      ? [{
        agent_id: "platform",
        wallet_address: c.env.PAYMENT_RECIPIENT,
        cumulative_delta: 1,
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
      } as any]
      : [],
  };

  if (!flexPaymentHeader && !legacyPaymentHeader && !legacyProofHeader) {
    // Sponsor decision: try platform-funded admission before emitting 402.
    // Only for authenticated agents; anonymous callers fall straight to 402.
    const agentIdRaw = (c as unknown as { get: (k: string) => string | undefined }).get("agent_id");
    // P0.3 soft-block: existing v6.15-era agents without complete Flex onboarding
    // get a 402 + X-Flex-Onboarding-Required BEFORE any sponsor or payment terms.
    if (agentIdRaw && agentIdRaw !== "__admin__") {
      const { checkFlexOnboardingOrBlock } = await import("../middleware/flex-onboarding-soft-block.js");
      const blockResp = await checkFlexOnboardingOrBlock(c as unknown as Parameters<typeof checkFlexOnboardingOrBlock>[0]);
      if (blockResp) return blockResp;
    }
    if (agentIdRaw && agentIdRaw !== "__admin__") {
      const { maybeSponsor } = await import("../middleware/sponsor.js");
      const sponsorAccepts = sponsorAcceptsForPriceUsd(priceUsd, searchRecipient);
      const decision = await maybeSponsor(c as unknown as Parameters<typeof maybeSponsor>[0], sponsorAccepts, agentIdRaw);
      if (decision.kind === "sponsored") {
        c.header("X-Sponsored", decision.ledger_id);
        c.header("X-Sponsor-Tx", decision.tx_hash);
        c.header("X-Sponsor-Remaining-Usd", decision.remaining_credit_usd.toFixed(6));
        return null; // Admit — caller proceeds with search.
      }
      if (decision.kind === "exhausted") {
        c.header("X-Sponsor-Exhausted", "1");
        c.header("X-Sponsor-Reason", decision.reason);
        c.header("X-Sponsor-Remaining-Usd", decision.remaining_credit_usd.toFixed(6));
        return await respondWithFlexTerms(
          c as unknown as Parameters<typeof respondWithFlexTerms>[0],
          { skill: searchSkill, priceUsd, resource: c.req.url, agentId: agentIdRaw },
        );
      }
      // opted_out — standard 402.
      c.header("X-Sponsor-Reason", "opted_out");
    }
    return await respondWithFlexTerms(
      c as unknown as Parameters<typeof respondWithFlexTerms>[0],
      { skill: searchSkill, priceUsd, resource: c.req.url, agentId: agentIdRaw },
    );
  }
  if (flexPaymentHeader) {
    // Flex authorization — verify + settle via the Flex facilitator. We
    // return Response.status=204 from executeFn as the "verified" marker,
    // then unwind into the caller letting the search run.
    const verifyResp = await handleFlexPaymentAuthorized(
      c as unknown as Parameters<typeof handleFlexPaymentAuthorized>[0],
      flexPaymentHeader,
      { executeFn: async () => new Response(null, { status: 204 }) },
    );
    if (verifyResp.status !== 204) return verifyResp;
    const settleHeader = verifyResp.headers.get("PAYMENT-RESPONSE");
    if (settleHeader) c.header("PAYMENT-RESPONSE", settleHeader);

    schedule(c, recordTransaction(c.env, {
      transaction_id: `flex-search-${Date.now()}`,
      // Auth-resolved keyId, never the raw bearer: the raw header is a secret
      // (the sanitizer redacts most shapes, but the resolved id is the correct
      // ledger key — it is what /dashboard/me reads back, so spend reconciles).
      consumer_id: (c as unknown as { get: (k: string) => string | undefined }).get("agent_id") ?? "anonymous",
      skill_id: skillId,
      price_usd: priceUsd,
      payment_proof: flexPaymentHeader,
    }).catch((err) => console.warn(`[flex] search ledger write failed: ${(err as Error).message}`)));
    return null;
  }

  // Caller sent only a legacy PAYMENT-SIGNATURE / X-Payment-Proof header.
  // v6.16 Phase 5 removed Corbits verify+settle entirely; emit a fresh
  // Flex 402 so the client re-pays under the new scheme.
  const agentIdForLegacy = (c as unknown as { get: (k: string) => string | undefined }).get("agent_id");
  return await respondWithFlexTerms(
    c as unknown as Parameters<typeof respondWithFlexTerms>[0],
    { skill: searchSkill, priceUsd, resource: c.req.url, agentId: agentIdForLegacy },
  );
}

export const searchRoutes = new Hono<{ Bindings: Env }>();

searchRoutes.use("/search", rateLimit({ limit: 30, window: 60, prefix: "search" }));
searchRoutes.use("/search/domain", rateLimit({ limit: 30, window: 60, prefix: "search" }));
searchRoutes.use("/search/resolve", rateLimit({ limit: 30, window: 60, prefix: "search" }));
searchRoutes.use("/search/rank", rateLimit({ limit: 60, window: 60, prefix: "search" }));
searchRoutes.use("/search/endpoints", rateLimit({ limit: 30, window: 60, prefix: "search" }));
searchRoutes.use("/search/web", rateLimit({ limit: 30, window: 60, prefix: "search-web" }));

// Web search price (USD). The owner ("__admin__") runs free; external callers
// pay this via x402 — the split then settles through the existing Flex gate.
const WEB_SEARCH_PRICE_USD = 0.01;

/**
 * Owner-exempt, otherwise-priced gate for the external web search.
 * Owner ("__admin__", i.e. the platform operator's key) → admit free. Everyone
 * else → the standard x402 path (priced at WEB_SEARCH_PRICE_USD, settled via Flex).
 */
async function requireWebSearchPayment<E extends { Bindings: Env }>(c: Context<E>): Promise<Response | null> {
  const agentId = (c as unknown as { get: (k: string) => string | undefined }).get("agent_id");
  if (agentId === "__admin__") return null; // owner → free.
  return runPricedSearchGate(c, "web", WEB_SEARCH_PRICE_USD);
}

/**
 * POST /v1/search/web — unbrowse's own external web search ("find the trees").
 *
 * Owner (admin key) requests run free; every other caller pays via x402 before
 * the search runs. Distinct from POST /v1/search, which is free local-index
 * discovery (PR #816). Engine comes from the provider chain (Exa primary when
 * EXA_API_KEY is set, keyless DDG fallback — services/web-search/).
 */
searchRoutes.post("/search/web", optionalAuth, signedClientIfAuthed, async (c) => {
  const { query, k } = await c.req.json<{ query?: string; k?: number }>().catch(() => ({ query: undefined, k: undefined }));
  if (!query || !query.trim()) return c.json({ error: "query required" }, 400);
  const gate = await requireWebSearchPayment(c);
  if (gate) return gate; // 402 Flex terms / onboarding for external callers.
  try {
    const topK = Math.min(Math.max(k ?? 5, 1), 20);
    // Semantic cache: a reworded repeat of a prior query returns the cached
    // results without re-running the live web round-trip. Fail-open — any cache
    // trouble falls through to a live webSearch. (Keyed per-k so a k=5 cache
    // never serves a k=20 request.)
    // Defer the cache write-through past the response (EmergentDB writes ~5s).
    const waitUntil = (p: Promise<unknown>) => {
      try { c.executionCtx?.waitUntil(p); } catch { /* no ctx (tests) → fire-and-forget */ }
    };
    const { value: results, cached } = await getOrComputeSemantic(
      c.env,
      `web:k${topK}`,
      query.trim(),
      () => webSearch(c.env, query.trim(), topK),
      waitUntil,
    );
    return c.json({ query: query.trim(), results, cached });
  } catch (err) {
    console.error("[search/web] web search failed:", (err as Error).message);
    return c.json({ query: query.trim(), results: [] });
  }
});


searchRoutes.post("/search", optionalAuth, signedClientIfAuthed, async (c) => {
  const { intent, k } = await c.req.json<{ intent: string; k?: number }>();
  if (!intent) return c.json({ error: "intent required" }, 400);
  try {
    // Anonymous = the public website skill registry. Free, rate-limited,
    // public-only (private skills are out of the graph index). Payment +
    // the search fee apply to authenticated agents doing programmatic
    // resolution -- that's where the x402 search economics belong.
    const isAnonymous = !c.get("agent_id");
    if (!isAnonymous) {
      const gate = await requireSearchPayment(c, "search");
      if (gate) return gate;
    }
    const agentId = c.get("agent_id") ?? "anonymous";
    const cacheTtlSeconds = 30;
    const results = shouldCacheSearch(c)
      ? await getCachedSearchPayload(c, `search:global:${normalizeSearchText(intent)}:${k ?? 5}`, cacheTtlSeconds, async () => ({
        results: await searchIntent(c.env, intent, k ?? 5),
      }))
      : { results: await searchIntent(c.env, intent, k ?? 5) };
    if (shouldCacheSearch(c)) setSearchCacheHeaders(c, cacheTtlSeconds);
    if (!isAnonymous && shouldRequireSearchPayment(c.env)) {
      chargeSearchFee(c.env, agentId);
      c.header("X-Unbrowse-Cost-Uc", String(GRAPH_OPERATION_COST_UC.search));
    }
    return c.json(results);
  } catch (err) {
    console.error("[search] global search failed:", (err as Error).message);
    return c.json({ results: [] });
  }
});

searchRoutes.post("/search/domain", indexContributorAuth, requireSignedClient, async (c) => {
  const { intent, domain, k } = await c.req.json<{ intent: string; domain: string; k?: number }>();
  if (!intent || !domain) return c.json({ error: "intent and domain required" }, 400);
  try {
    const gate = await requireSearchPayment(c, "search-domain");
    if (gate) return gate;
    const agentId = c.get("agent_id") ?? "anonymous";
    const cacheTtlSeconds = 30;
    const results = shouldCacheSearch(c)
      ? await getCachedSearchPayload(c, `search:domain:${domain.toLowerCase()}:${normalizeSearchText(intent)}:${k ?? 5}`, cacheTtlSeconds, async () => ({
        results: await searchIntentInDomain(c.env, intent, domain, k ?? 5),
      }))
      : { results: await searchIntentInDomain(c.env, intent, domain, k ?? 5) };
    if (shouldCacheSearch(c)) setSearchCacheHeaders(c, cacheTtlSeconds);
    if (shouldRequireSearchPayment(c.env)) {
      chargeSearchFee(c.env, agentId);
      c.header("X-Unbrowse-Cost-Uc", String(GRAPH_OPERATION_COST_UC.search));
    }
    return c.json(results);
  } catch (err) {
    console.error("[search] domain search failed:", (err as Error).message);
    return c.json({ results: [] });
  }
});

searchRoutes.post("/search/resolve", indexContributorAuth, requireSignedClient, async (c) => {
  const { intent, domain, domain_k, global_k } = await c.req.json<{
    intent: string;
    domain?: string;
    domain_k?: number;
    global_k?: number;
  }>();
  if (!intent) return c.json({ error: "intent required" }, 400);
  try {
    const gate = await requireSearchPayment(c, "search-resolve");
    if (gate) return gate;
    const agentId = c.get("agent_id") ?? "anonymous";
    const cacheTtlSeconds = 60;

    // W17 cache wrap. The resolve endpoint is the highest-volume hot path;
    // a single resolve walks marketplace + cache + first-pass capture, all
    // of which are expensive. Cache key is sha256(intent + ":" +
    // normalized URL surrogate) — neither intent nor URL leaks at the
    // key layer (hash-only). domain + k caps fold into the URL surrogate
    // so different shortlist sizes don't collide. TTL=60s with SWR ON
    // — resolve responses are stable for tens of seconds on the same
    // intent (the marketplace doesn't churn that fast), so SWR drives
    // the hit-rate up. Matt 6:34 — sufficient unto the day.
    //
    // SECURITY: the resolve response carries ONLY endpoint metadata
    // (URL templates, methods, schemas, agent-augmented descriptions) —
    // already public on /v1/skills/* anyway. NO bearer key, NO wallet
    // pubkey, NO session token enters the response or the key.
    const noCacheHdr = c.req.header("cache-control")?.toLowerCase().includes("no-cache") ?? false;
    const ifNoneMatch = c.req.header("if-none-match")?.replace(/^"|"$/g, "") ?? undefined;
    const surrogateUrl = `${domain?.toLowerCase() ?? "all"}?dk=${domain_k ?? 5}&gk=${global_k ?? 10}`;
    const key = await resolveCacheKey(normalizeSearchText(intent), surrogateUrl);

    let cacheResult;
    try {
      cacheResult = await withCache(
        c.env,
        key,
        cacheTtlSeconds,
        {
          bypass: noCacheHdr,
          staleWhileRevalidate: true,
          ctx: safeExecutionCtx(c),
          honorIfNoneMatch: ifNoneMatch,
        },
        async () =>
          searchIntentResolve(c.env, intent, domain, domain_k ?? 5, global_k ?? 10),
      );
    } catch (cacheErr) {
      if (cacheErr instanceof CacheNotModified) {
        c.header("ETag", `"${cacheErr.etag}"`);
        c.header("X-Cache", "HIT");
        return c.body(null, 304);
      }
      throw cacheErr;
    }

    const headers = buildCacheHeaders(cacheResult);
    for (const [k, v] of Object.entries(headers)) c.header(k, v);
    if (shouldCacheSearch(c)) setSearchCacheHeaders(c, cacheTtlSeconds);
    if (shouldRequireSearchPayment(c.env)) {
      chargeSearchFee(c.env, agentId);
      c.header("X-Unbrowse-Cost-Uc", String(GRAPH_OPERATION_COST_UC.search));
    }
    // Internal canonical-anchor ordering — presentation-time, non-destructive,
    // default-OFF. The relevance cache above is untouched (still relevance-
    // ordered); when enabled + confident, the finalists are sequenced by their
    // nearest canonical anchor. Fail-closed: unchanged on any miss/low-confidence.
    const value = c.env.BIBLE_ANCHOR_ORDER === "1"
      ? await orderResolvedResults(c.env, cacheResult.value as Parameters<typeof orderResolvedResults>[1])
      : cacheResult.value;
    return c.json(value);
  } catch (err) {
    console.error("[search] resolve search failed:", (err as Error).message);
    return c.json({ domain_results: [], global_results: [], skipped_global: false });
  }
});

// POST /v1/search/endpoints -- semantic search across ALL indexed endpoints,
// flat shape (one row per endpoint). The existing /v1/search returns
// {results: [{id, score, metadata}]} where metadata.content is a JSON-
// stringified blob; this route unwraps the canonical schema server-side so
// the SDK / MCP / CLI consumer gets a structured EndpointSearchHit row
// directly. Anonymous-allowed (same gating as /v1/search) so public
// discovery works without an API key; authenticated agents pay the
// search fee per the existing x402 economics.
searchRoutes.post("/search/endpoints", optionalAuth, signedClientIfAuthed, async (c) => {
  const { intent, k, domain } = await c.req.json<{ intent: string; k?: number; domain?: string }>();
  if (!intent) return c.json({ error: "intent required" }, 400);
  try {
    const isAnonymous = !c.get("agent_id");
    if (!isAnonymous) {
      const gate = await requireSearchPayment(c, "search-endpoints");
      if (gate) return gate;
    }
    const agentId = c.get("agent_id") ?? "anonymous";
    const cacheTtlSeconds = 30;
    const limit = Math.min(50, Math.max(1, k ?? 10));
    const cacheKey = `search:endpoints:${(domain ?? "global").toLowerCase()}:${normalizeSearchText(intent)}:${limit}`;
    const endpoints: EndpointSearchHit[] = shouldCacheSearch(c)
      ? (await getCachedSearchPayload(c, cacheKey, cacheTtlSeconds, async () => ({
          endpoints: await searchEndpoints(c.env, intent, limit, domain),
        }))).endpoints
      : await searchEndpoints(c.env, intent, limit, domain);
    if (shouldCacheSearch(c)) setSearchCacheHeaders(c, cacheTtlSeconds);
    if (!isAnonymous && shouldRequireSearchPayment(c.env)) {
      chargeSearchFee(c.env, agentId);
      c.header("X-Unbrowse-Cost-Uc", String(GRAPH_OPERATION_COST_UC.search));
    }
    return c.json({ endpoints });
  } catch (err) {
    console.error("[search] endpoint search failed:", (err as Error).message);
    return c.json({ endpoints: [] });
  }
});


// POST /v1/search/rank — server-side evidence-derived endpoint ranker.
//
// WAVE 2 of the server-move: the ranking *intelligence* moves off the
// npm bundle. The client posts the captured/marketplace endpoints for a
// resolve and gets back a ranked shortlist with per-signal evidence so
// the calling agent's LLM can judge ties itself (two-tool-call contract:
// resolve = server intelligence, execute = client auth-context). No
// per-domain registry, no second LLM — pure evidence-derived signals.
// The client keeps a full local ranker as a degraded fallback for when
// this route is unreachable, so offline resolve never hard-fails.
searchRoutes.post("/search/rank", indexContributorAuth, requireSignedClient, async (c) => {
  let body: RankRequest;
  try {
    body = await c.req.json<RankRequest>();
  } catch {
    return c.json({ error: "invalid json" }, 400);
  }
  if (!Array.isArray(body?.endpoints)) {
    return c.json({ error: "endpoints[] required" }, 400);
  }
  // Bound the payload so a hostile client can't pin a Worker isolate.
  if (body.endpoints.length > 500) {
    body = { ...body, endpoints: body.endpoints.slice(0, 500) };
  }
  try {
    const result = rankEndpointsServer(body);
    return c.json(result);
  } catch (err) {
    console.error("[search] rank failed:", (err as Error).message);
    // Signal degraded so the client keeps its local fallback authoritative.
    return c.json({ ranked: [], degraded: true });
  }
});
