import { Hono } from "hono";
import { cors } from "hono/cors";
import type { Env } from "./types.js";
import { bearerAuth } from "./middleware/auth.js";
import { skillRoutes, publicSkillRoutes } from "./routes/skills.js";
import { searchRoutes } from "./routes/search.js";
import { statsRoutes, publicStatsRoutes, publicValidateRoutes } from "./routes/stats.js";
import { analyticsRoutes } from "./routes/analytics.js";
import { healthRoutes } from "./routes/health.js";
import { publicAgentRoutes } from "./routes/agents.js";
import { publicIssueRoutes, issueRoutes } from "./routes/issues.js";
import { opsRoutes } from "./routes/ops.js";
import { graphRoutes } from "./routes/graph.js";
import { telemetryRoutes } from "./routes/telemetry.js";
import { feeRoutes } from "./routes/fees.js";
import { transactionRoutes } from "./routes/transactions.js";
import { attributionRoutes } from "./routes/attribution.js";
import { publicDashboardRoutes, dashboardRoutes } from "./routes/dashboard.js";

const app = new Hono<{ Bindings: Env }>();

// CORS for all routes
app.use("*", cors({
  origin: "*",
  allowMethods: ["GET", "POST", "PUT", "PATCH", "OPTIONS"],
  allowHeaders: ["Content-Type", "Authorization", "PAYMENT-SIGNATURE", "X-Payment-Proof"],
  exposeHeaders: ["PAYMENT-REQUIRED", "PAYMENT-RESPONSE", "X-Payment-Required"],
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
app.route("/v1", feeRoutes);
app.route("/v1", telemetryRoutes);
app.route("/v1", transactionRoutes);
app.route("/v1", attributionRoutes);
app.route("/v1", publicDashboardRoutes);

// Issue routes with inline auth (POST/PATCH require auth, GET is public above)
app.route("/v1", issueRoutes);

// Protected routes (writes only) -- bearerAuth is applied to the specific
// paths used by write routes, not via use("*") which would intercept all /v1/*
// requests including public ones like /agents/register.
skillRoutes.use("/skills", bearerAuth);
skillRoutes.use("/skills/*", bearerAuth);
statsRoutes.use("/stats/*", bearerAuth);
app.route("/v1", skillRoutes);
app.route("/v1", statsRoutes);
app.route("/v1", dashboardRoutes);

export default app;
