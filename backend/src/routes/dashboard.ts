import { Hono } from "hono";
import type { Env } from "../types.js";
import { buildDashboard, buildLeaderboard } from "../services/economics.js";
import { bearerAuth } from "../middleware/auth.js";

export const publicDashboardRoutes = new Hono<{ Bindings: Env }>();
export const dashboardRoutes = new Hono<{ Bindings: Env; Variables: { agent_id: string } }>();

publicDashboardRoutes.get("/leaderboard", async (c) => {
  const limit = Math.min(Math.max(Number(c.req.query("limit") ?? 50), 1), 100);
  const entries = await buildLeaderboard(c.env, limit);
  c.header("Cache-Control", "public, max-age=30");
  return c.json({ entries });
});

dashboardRoutes.get("/dashboard/me", bearerAuth, async (c) => {
  const agentId = c.get("agent_id");
  const dashboard = await buildDashboard(c.env, agentId);
  if (!dashboard) return c.json({ error: "Agent profile not found" }, 404);
  return c.json(dashboard);
});
