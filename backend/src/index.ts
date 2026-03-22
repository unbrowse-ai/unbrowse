import { Hono } from "hono";
import { cors } from "hono/cors";
import type { Env } from "./types.js";
import { skillRoutes, publicSkillRoutes } from "./routes/skills.js";
import { searchRoutes } from "./routes/search.js";
import { statsRoutes, publicStatsRoutes, publicValidateRoutes } from "./routes/stats.js";
import { analyticsRoutes } from "./routes/analytics.js";
import { healthRoutes } from "./routes/health.js";
import { publicAgentRoutes } from "./routes/agents.js";
import { publicIssueRoutes, issueRoutes } from "./routes/issues.js";
import { opsRoutes } from "./routes/ops.js";
import { graphRoutes } from "./routes/graph.js";

const app = new Hono<{ Bindings: Env }>();

// CORS for all routes
app.use("*", cors({
  origin: "*",
  allowMethods: ["GET", "POST", "PUT", "PATCH", "OPTIONS"],
  allowHeaders: ["Content-Type", "Authorization"],
  maxAge: 86400,
}));

// Public routes (reads, search, validation, agent registration, issues list)
app.route("/", healthRoutes);
app.route("/v1", publicStatsRoutes);
app.route("/v1", searchRoutes);
app.route("/v1", publicSkillRoutes);
app.route("/v1", publicValidateRoutes);
app.route("/v1", analyticsRoutes);
app.route("/v1", publicAgentRoutes);
app.route("/v1", publicIssueRoutes);
app.route("/v1", opsRoutes);
app.route("/v1", graphRoutes);

// Issue routes with inline auth (POST/PATCH require auth, GET is public above)
app.route("/v1", issueRoutes);

// Protected routes scope auth inside the write-only routers.
app.route("/v1", skillRoutes);
app.route("/v1", statsRoutes);

export default app;
