import { Hono } from "hono";
import type { Env } from "../types.js";
import { createIssue, listIssues, updateIssueStatus, type IssueCategory, type IssueStatus } from "../services/issues.js";
import { bearerAuth } from "../middleware/auth.js";
import { rateLimit, agentRateLimit } from "../middleware/rate-limit.js";

const VALID_CATEGORIES: IssueCategory[] = ["broken", "wrong_data", "needs_auth", "rate_limited", "stale_schema", "missing_endpoint", "other"];

// Public issue routes
export const publicIssueRoutes = new Hono<{ Bindings: Env }>();

publicIssueRoutes.use("/skills/:id/issues", rateLimit({ limit: 20, window: 60, prefix: "issues-list" }));

// GET /v1/skills/:id/issues — list issues for a skill
publicIssueRoutes.get("/skills/:id/issues", async (c) => {
  const skillId = c.req.param("id");
  const status = c.req.query("status") as IssueStatus | undefined;
  const limit = Math.min(Number(c.req.query("limit") ?? 20), 50);
  const issues = await listIssues(c.env, skillId, status, limit);
  return c.json({ issues });
});

// Protected issue routes
export const issueRoutes = new Hono<{ Bindings: Env; Variables: { agent_id: string } }>();

// POST /v1/skills/:id/issues — report an issue (requires auth, 10 per 60s per agent)
issueRoutes.post("/skills/:id/issues", bearerAuth, agentRateLimit({ limit: 10, window: 60, prefix: "issue-create" }), async (c) => {
  const skillId = c.req.param("id");
  const agentId = c.get("agent_id");
  const { category, description, endpoint_id, trace_id } = await c.req.json<{
    category: string;
    description: string;
    endpoint_id?: string;
    trace_id?: string;
  }>();

  if (!category || !description) {
    return c.json({ error: "category and description are required" }, 400);
  }
  if (!VALID_CATEGORIES.includes(category as IssueCategory)) {
    return c.json({ error: `Invalid category. Must be one of: ${VALID_CATEGORIES.join(", ")}` }, 400);
  }

  const issue = await createIssue(c.env, skillId, agentId, category as IssueCategory, description, endpoint_id, trace_id);
  return c.json(issue, 201);
});

// PATCH /v1/skills/:id/issues/:issue_id — update issue status (admin only)
issueRoutes.patch("/skills/:id/issues/:issue_id", bearerAuth, async (c) => {
  const agentId = c.get("agent_id");
  if (agentId !== "__admin__") {
    return c.json({ error: "Admin only" }, 403);
  }
  const { status } = await c.req.json<{ status: IssueStatus }>();
  if (!["open", "acknowledged", "resolved"].includes(status)) {
    return c.json({ error: "Invalid status" }, 400);
  }
  await updateIssueStatus(c.env, c.req.param("id"), c.req.param("issue_id"), status);
  return c.json({ ok: true });
});
