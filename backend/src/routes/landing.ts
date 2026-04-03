import { Context, Hono } from "hono";
import type { Env, LandingVariantContent, LandingVariantStatus } from "../types.js";
import {
  getLandingVariant,
  getLandingVariantSummary,
  listLandingVariants,
  publishLandingVariant,
  resolveLandingVariant,
  updateLandingVariant,
} from "../services/landing.js";

export const landingRoutes = new Hono<{ Bindings: Env }>();

function safeCompare(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  const encoder = new TextEncoder();
  const aa = encoder.encode(a);
  const bb = encoder.encode(b);
  let diff = 0;
  for (let i = 0; i < aa.length; i += 1) diff |= aa[i] ^ bb[i];
  return diff === 0;
}

function isWriteAuthorized(c: Context<{ Bindings: Env }>): boolean {
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
