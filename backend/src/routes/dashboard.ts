import { Hono } from "hono";
import type { Env } from "../types.js";
import { buildDashboard, buildLeaderboard } from "../services/economics.js";
import { bearerAuth } from "../middleware/auth.js";
import { getAgentIdByWallet } from "../services/agents.js";
import { getOrSetHttpCache } from "../services/http-cache.js";

export const publicDashboardRoutes = new Hono<{ Bindings: Env }>();
export const dashboardRoutes = new Hono<{ Bindings: Env; Variables: { agent_id: string } }>();

publicDashboardRoutes.get("/leaderboard", async (c) => {
  const limit = Math.min(Math.max(Number(c.req.query("limit") ?? 50), 1), 100);
  const { entries } = await getOrSetHttpCache(c.env, `leaderboard:${limit}`, 30, async () => ({
    entries: await buildLeaderboard(c.env, limit),
  }));
  c.header("Cache-Control", "public, max-age=30, s-maxage=30, stale-while-revalidate=120");
  return c.json({ entries });
});

publicDashboardRoutes.get("/dashboard/wallet/:walletAddress", async (c) => {
  const walletAddress = c.req.param("walletAddress");
  const cached = await getOrSetHttpCache(
    c.env,
    `dashboard:wallet:${encodeURIComponent(walletAddress)}`,
    30,
    async () => {
      const agentId = await getAgentIdByWallet(c.env, walletAddress);
      if (!agentId) return { error: "wallet_not_found" as const };
      const dashboard = await buildDashboard(c.env, agentId);
      if (!dashboard) return { error: "Agent profile not found" as const };
      return { dashboard };
    },
  );
  if ("error" in cached) return c.json({ error: cached.error }, cached.error === "wallet_not_found" ? 404 : 404);
  c.header("Cache-Control", "public, max-age=30, s-maxage=30, stale-while-revalidate=120");
  const { dashboard } = cached;
  return c.json(dashboard);
});

dashboardRoutes.get("/dashboard/me", bearerAuth, async (c) => {
  const agentId = c.get("agent_id");
  const dashboard = await buildDashboard(c.env, agentId);
  if (!dashboard) return c.json({ error: "Agent profile not found" }, 404);
  return c.json(dashboard);
});
