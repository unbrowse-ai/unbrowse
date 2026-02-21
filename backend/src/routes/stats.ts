import { Hono } from "hono";
import type { Env } from "../types.js";
import { recordExecution, recordFeedback } from "../services/scoring.js";
import { validateSkillManifest } from "../services/validator.js";

export const statsRoutes = new Hono<{ Bindings: Env }>();

// POST /v1/stats/execution — record execution + recompute score
statsRoutes.post("/stats/execution", async (c) => {
  const { skill_id, endpoint_id, trace } = await c.req.json<{
    skill_id: string;
    endpoint_id: string;
    trace: import("../types.js").ExecutionTrace;
  }>();
  if (!skill_id || !endpoint_id || !trace) {
    return c.json({ error: "skill_id, endpoint_id, and trace required" }, 400);
  }
  await recordExecution(c.env, skill_id, endpoint_id, trace);
  return c.json({ ok: true });
});

// POST /v1/stats/feedback — record feedback + recompute score
statsRoutes.post("/stats/feedback", async (c) => {
  const { skill_id, endpoint_id, rating } = await c.req.json<{
    skill_id: string;
    endpoint_id: string;
    rating: number;
  }>();
  if (!skill_id || !endpoint_id || rating == null) {
    return c.json({ error: "skill_id, endpoint_id, and rating required" }, 400);
  }
  const avgRating = await recordFeedback(c.env, skill_id, endpoint_id, rating);
  return c.json({ ok: true, avg_rating: avgRating });
});

// POST /v1/validate — validate skill manifest
statsRoutes.post("/validate", async (c) => {
  const body = await c.req.json();
  const result = validateSkillManifest(body);
  return c.json(result);
});
