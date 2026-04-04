import { Hono, type Context } from "hono";
import type { Env, LandingVariantContent, LandingVariantStatus } from "../types.js";
import { bearerAuth } from "../middleware/auth.js";
import {
  getActiveLandingHomepageVariant,
  assignLandingHomepageVariant,
  encodeLandingHomepageAssignmentCookie,
  getLandingHomepageAnalyticsSummary,
  getLandingHomepageExperimentConfig,
  mintLandingHomepageToken,
  saveLandingHomepageExperimentConfig,
} from "../services/landing-experiments.js";
import { getOrSetHttpCache } from "../services/http-cache.js";
import { buildCacheControl, getEdgeCacheJson, putEdgeCacheJson } from "../services/edge-cache.js";
import {
  getLandingVariant,
  getLandingVariantSummary,
  listLandingVariants,
  publishLandingVariant,
  resolveLandingVariant,
  updateLandingVariant,
} from "../services/landing.js";

export const landingRoutes = new Hono<{ Bindings: Env; Variables: { agent_id: string } }>();

function schedule(c: Context, task: Promise<unknown>): void {
  try {
    (c as Context & { executionCtx: ExecutionContext }).executionCtx.waitUntil(task);
  } catch {
    void task;
  }
}

function safeCompare(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  const encoder = new TextEncoder();
  const aa = encoder.encode(a);
  const bb = encoder.encode(b);
  let diff = 0;
  for (let i = 0; i < aa.length; i += 1) diff |= aa[i] ^ bb[i];
  return diff === 0;
}

function isWriteAuthorized(c: Context<{ Bindings: Env; Variables: { agent_id: string } }>): boolean {
  const auth = c.req.header("Authorization");
  if (!auth?.startsWith("Bearer ")) return false;
  const token = auth.slice(7);
  if (c.env.LANDING_PUBLISH_KEY && safeCompare(token, c.env.LANDING_PUBLISH_KEY)) return true;
  return !!c.env.API_KEY && safeCompare(token, c.env.API_KEY);
}

function parseStatus(value: string | undefined): LandingVariantStatus | undefined {
  if (value === "draft" || value === "active" || value === "archived") return value;
  return undefined;
}

landingRoutes.get("/landing/homepage/active", async (c) => {
  const cacheKey = "landing:homepage:active:v1";
  const ttlSeconds = 300;
  const edgeCached = await getEdgeCacheJson<Awaited<ReturnType<typeof getActiveLandingHomepageVariant>>>(cacheKey);
  if (edgeCached) {
    c.header("Cache-Control", buildCacheControl(ttlSeconds));
    return c.json(edgeCached);
  }

  const payload = await getOrSetHttpCache(c.env, cacheKey, ttlSeconds, async () => getActiveLandingHomepageVariant(c.env));
  c.header("Cache-Control", buildCacheControl(ttlSeconds));
  schedule(c, putEdgeCacheJson(cacheKey, payload, ttlSeconds));
  return c.json(payload);
});

landingRoutes.post("/landing/homepage/assign", async (c) => {
  const body = await c.req.json<{
    visitor_id?: string;
    current_assignment?: string | null;
  }>().catch(() => null);

  if (!body?.visitor_id) {
    return c.json({ error: "visitor_id is required" }, 400);
  }

  const assigned = await assignLandingHomepageVariant(c.env, body.visitor_id, body.current_assignment);
  return c.json({
    assignment: assigned.assignment,
    assignment_cookie: encodeLandingHomepageAssignmentCookie(assigned.assignment),
    content: assigned.content,
    status: assigned.status,
  });
});

landingRoutes.post("/landing/homepage/token", async (c) => {
  const body = await c.req.json<{
    experiment_id?: string;
    variant_id?: string;
    visitor_id?: string;
    session_id?: string;
  }>().catch(() => null);

  if (!body?.experiment_id || !body.variant_id || !body.visitor_id || !body.session_id) {
    return c.json({ error: "experiment_id, variant_id, visitor_id, and session_id are required" }, 400);
  }

  try {
    const minted = await mintLandingHomepageToken(c.env, {
      experiment_id: body.experiment_id,
      variant_id: body.variant_id,
      visitor_id: body.visitor_id,
      session_id: body.session_id,
    });
    return c.json({ token: minted.token, claims: minted.claims });
  } catch (error) {
    return c.json({ error: error instanceof Error ? error.message : "unable_to_mint_token" }, 400);
  }
});

landingRoutes.use("/landing/homepage/config", bearerAuth);
landingRoutes.use("/landing/homepage/analytics", bearerAuth);

landingRoutes.get("/landing/homepage/config", async (c) => {
  if (c.get("agent_id") !== "__admin__") return c.json({ error: "Admin only" }, 403);
  return c.json(await getLandingHomepageExperimentConfig(c.env));
});

landingRoutes.put("/landing/homepage/config", async (c) => {
  if (c.get("agent_id") !== "__admin__") return c.json({ error: "Admin only" }, 403);
  const body = await c.req.json().catch(() => null);
  if (!body || typeof body !== "object") {
    return c.json({ error: "invalid config" }, 400);
  }
  return c.json(await saveLandingHomepageExperimentConfig(c.env, body as any));
});

landingRoutes.get("/landing/homepage/analytics", async (c) => {
  if (c.get("agent_id") !== "__admin__") return c.json({ error: "Admin only" }, 403);
  const days = Math.min(parseInt(c.req.query("days") ?? "30", 10), 180);
  return c.json(await getLandingHomepageAnalyticsSummary(c.env, days));
});

landingRoutes.get("/landing/variants", async (c) => {
  const includeInactive = isWriteAuthorized(c);
  const icp = c.req.query("icp")?.trim();
  const experimentId = c.req.query("experiment_id")?.trim();
  const status = parseStatus(c.req.query("status"));
  const variants = await listLandingVariants(c.env, {
    icp,
    experiment_id: experimentId,
    status,
    include_inactive: includeInactive,
  });
  return c.json({ variants });
});

landingRoutes.get("/landing/variants/:id", async (c) => {
  const variant = await getLandingVariant(c.env, c.req.param("id"));
  if (!variant) return c.json({ error: "not found" }, 404);
  if (variant.status !== "active" && !isWriteAuthorized(c)) return c.json({ error: "not found" }, 404);
  return c.json(variant);
});

landingRoutes.get("/landing/resolve", async (c) => {
  const variant = await resolveLandingVariant(c.env, {
    variant_id: c.req.query("variant_id")?.trim(),
    icp: c.req.query("icp")?.trim(),
    experiment_id: c.req.query("experiment_id")?.trim(),
    seed: c.req.query("seed")?.trim(),
  });
  if (!variant) return c.json({ variant: null }, 404);
  return c.json({ variant });
});

landingRoutes.post("/landing/variants/publish", async (c) => {
  if (!isWriteAuthorized(c)) return c.json({ error: "unauthorized" }, 401);
  const body = await c.req.json<{
    variant_id?: string;
    slug?: string;
    name?: string;
    icp?: string;
    experiment_id?: string;
    status?: LandingVariantStatus;
    weight?: number;
    content?: LandingVariantContent;
    notes?: string;
  }>().catch(() => null);

  if (!body?.name || !body.icp) {
    return c.json({ error: "name and icp are required" }, 400);
  }

  const variant = await publishLandingVariant(c.env, {
    variant_id: body.variant_id,
    slug: body.slug,
    name: body.name,
    icp: body.icp,
    experiment_id: body.experiment_id,
    status: body.status,
    weight: body.weight,
    content: body.content,
    notes: body.notes,
  });

  return c.json({ ok: true, variant });
});

landingRoutes.patch("/landing/variants/:id", async (c) => {
  if (!isWriteAuthorized(c)) return c.json({ error: "unauthorized" }, 401);
  const body = await c.req.json<{
    slug?: string;
    name?: string;
    icp?: string;
    experiment_id?: string;
    status?: LandingVariantStatus;
    weight?: number;
    content?: LandingVariantContent;
    notes?: string;
  }>().catch(() => null);

  if (!body) return c.json({ error: "invalid body" }, 400);
  const variant = await updateLandingVariant(c.env, c.req.param("id"), body);
  if (!variant) return c.json({ error: "not found" }, 404);
  return c.json({ ok: true, variant });
});

landingRoutes.get("/landing/summary", async (c) => {
  if (!isWriteAuthorized(c)) return c.json({ error: "unauthorized" }, 401);
  const days = Number(c.req.query("days") ?? "30");
  const icp = c.req.query("icp")?.trim();
  const experimentId = c.req.query("experiment_id")?.trim();
  const summary = await getLandingVariantSummary(c.env, {
    days,
    icp,
    experiment_id: experimentId,
  });
  return c.json(summary);
});
