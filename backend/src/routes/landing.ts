import { Hono } from "hono";
import type { Env } from "../types.js";
import { bearerAuth } from "../middleware/auth.js";
import {
  assignLandingHomepageVariant,
  encodeLandingHomepageAssignmentCookie,
  getLandingHomepageAnalyticsSummary,
  getLandingHomepageExperimentConfig,
  mintLandingHomepageToken,
  saveLandingHomepageExperimentConfig,
} from "../services/landing-experiments.js";

export const landingRoutes = new Hono<{ Bindings: Env; Variables: { agent_id: string } }>();

landingRoutes.post("/landing/homepage/assign", async (c) => {
  const body = await c.req.json<{
    visitor_id?: string;
    current_assignment?: string | null;
    icp?: string | null;
  }>().catch(() => null);

  if (!body?.visitor_id) {
    return c.json({ error: "visitor_id is required" }, 400);
  }

  const assigned = await assignLandingHomepageVariant(c.env, body.visitor_id, body.current_assignment, body.icp);
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
