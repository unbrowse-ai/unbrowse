import { Hono, type Context } from "hono";
import type { Env } from "../types.js";
import { searchIntent, searchIntentInDomain, searchIntentResolve } from "../services/discovery.js";
import { rateLimit } from "../middleware/rate-limit.js";
import { bearerAuth, requireSignedClient } from "../middleware/auth.js";
import { GRAPH_OPERATION_COST_UC, recordGraphFee } from "../services/fees.js";
import { buildSkillPaymentTerms, searchPaymentsEnabled, verifyX402Proof, x402Response, x402UseTestnet } from "../middleware/x402-gate.js";
import { getOrSetHttpCache } from "../services/http-cache.js";
import { recordTransaction } from "../services/transactions.js";
import { buildCacheControl, getEdgeCacheJson, putEdgeCacheJson } from "../services/edge-cache.js";
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

function shouldRequireSearchPayment(env: Env): boolean {
  return searchPaymentsEnabled(env);
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

  const paymentHeader = c.req.header("PAYMENT-SIGNATURE");
  const legacyProofHeader = c.req.header("X-Payment-Proof");
  if (!paymentHeader && !legacyProofHeader) {
    const recipient = c.env.PAYMENT_RECIPIENT ?? "0x0000000000000000000000000000000000000000";
    const priceUsd = GRAPH_OPERATION_COST_UC.search / 1_000_000;
    const terms = await buildSkillPaymentTerms(
      priceUsd,
      `graph-search:${routeLabel}`,
      recipient,
      c.req.url,
      { testnet: x402UseTestnet(c.env) },
    );
    return x402Response(c, terms);
  }
  const proof = paymentHeader ?? legacyProofHeader!;
  const { valid, degraded, transaction, settlementHeader } = await verifyX402Proof(proof);
  if (!valid) return c.json({ error: "Payment proof invalid or rejected" }, 403);
  if (degraded) {
    console.warn(`[x402] facilitator down -- allowed degraded access for graph search ${routeLabel}`);
  }
  if (settlementHeader) c.header("PAYMENT-RESPONSE", settlementHeader);

  // Record search payment to ledger (non-blocking)
  const txId = transaction ?? `x402-search-${Date.now()}`;
  const priceUsd = GRAPH_OPERATION_COST_UC.search / 1_000_000;
  schedule(c, recordTransaction(c.env, {
    transaction_id: txId,
    consumer_id: c.req.header("Authorization")?.replace("Bearer ", "") ?? "anonymous",
    skill_id: `graph-search:${routeLabel}`,
    price_usd: priceUsd,
    payment_proof: proof,
  }).catch((err) => console.warn(`[x402] search ledger write failed: ${(err as Error).message}`)));

  return null;
}

export const searchRoutes = new Hono<{ Bindings: Env }>();

searchRoutes.use("/search", rateLimit({ limit: 30, window: 60, prefix: "search" }));
searchRoutes.use("/search/domain", rateLimit({ limit: 30, window: 60, prefix: "search" }));
searchRoutes.use("/search/resolve", rateLimit({ limit: 30, window: 60, prefix: "search" }));

searchRoutes.post("/search", bearerAuth, requireSignedClient, async (c) => {
  const { intent, k } = await c.req.json<{ intent: string; k?: number }>();
  if (!intent) return c.json({ error: "intent required" }, 400);
  try {
    const gate = await requireSearchPayment(c, "search");
    if (gate) return gate;
    const agentId = c.get("agent_id") ?? "anonymous";
    const cacheTtlSeconds = 30;
    const results = shouldCacheSearch(c)
      ? await getCachedSearchPayload(c, `search:global:${normalizeSearchText(intent)}:${k ?? 5}`, cacheTtlSeconds, async () => ({
        results: await searchIntent(c.env, intent, k ?? 5),
      }))
      : { results: await searchIntent(c.env, intent, k ?? 5) };
    if (shouldCacheSearch(c)) setSearchCacheHeaders(c, cacheTtlSeconds);
    if (shouldRequireSearchPayment(c.env)) {
      chargeSearchFee(c.env, agentId);
      c.header("X-Unbrowse-Cost-Uc", String(GRAPH_OPERATION_COST_UC.search));
    }
    return c.json(results);
  } catch (err) {
    console.error("[search] global search failed:", (err as Error).message);
    return c.json({ results: [] });
  }
});

searchRoutes.post("/search/domain", bearerAuth, requireSignedClient, async (c) => {
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

searchRoutes.post("/search/resolve", bearerAuth, requireSignedClient, async (c) => {
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
    const cacheTtlSeconds = 30;
    const results = shouldCacheSearch(c)
      ? await getCachedSearchPayload(
        c,
        `search:resolve:${domain?.toLowerCase() ?? "all"}:${normalizeSearchText(intent)}:${domain_k ?? 5}:${global_k ?? 10}`,
        cacheTtlSeconds,
        async () => searchIntentResolve(c.env, intent, domain, domain_k ?? 5, global_k ?? 10),
      )
      : await searchIntentResolve(c.env, intent, domain, domain_k ?? 5, global_k ?? 10);
    if (shouldCacheSearch(c)) setSearchCacheHeaders(c, cacheTtlSeconds);
    if (shouldRequireSearchPayment(c.env)) {
      chargeSearchFee(c.env, agentId);
      c.header("X-Unbrowse-Cost-Uc", String(GRAPH_OPERATION_COST_UC.search));
    }
    return c.json(results);
  } catch (err) {
    console.error("[search] resolve search failed:", (err as Error).message);
    return c.json({ domain_results: [], global_results: [], skipped_global: false });
  }
});
