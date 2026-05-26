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
import { telemetryRoutes } from "./routes/telemetry.js";
import { feeRoutes } from "./routes/fees.js";
import { transactionRoutes } from "./routes/transactions.js";
import { attributionRoutes } from "./routes/attribution.js";
import { publicDashboardRoutes, dashboardRoutes } from "./routes/dashboard.js";
import { publicMinerRoutes } from "./routes/miners.js";
import { blogRoutes } from "./routes/blog.js";
import { landingRoutes } from "./routes/landing.js";
import { webhookRoutes } from "./routes/webhooks.js";
import { creditRoutes } from "./routes/credits.js";
import { billingRoutes } from "./routes/billing.js";
import { authRoutes } from "./routes/auth.js";
import { claimRoutes } from "./routes/claim.js";
import { accountRoutes } from "./routes/account.js";
import { cookieRoutes } from "./routes/cookies.js";
import { adminRoutes } from "./routes/admin.js";
import { syntheticRoutes } from "./routes/synthetic.js";
import { llmRoutes } from "./routes/llm.js";
import { proxyRoutes } from "./routes/proxy.js";
import { contractRoutes } from "./routes/contract.js";
import { provisionPodRoutes } from "./routes/provision-pod.js";
import { openaiToolsRoutes } from "./routes/openai-tools.js";
import { extractRoutes } from "./routes/extract.js";
import {
  mountFaremeterTestRoute,
  stubFaremeterHandlers,
  stubFaremeterPricing,
} from "./routes/faremeter-test.js";
import { flushQueuedGithubNotifications } from "./services/github-webhooks.js";

const app = new Hono<{ Bindings: Env }>();

// CORS for all routes
app.use("*", cors({
  origin: "*",
  allowMethods: ["GET", "POST", "PUT", "PATCH", "OPTIONS"],
  allowHeaders: [
    "Content-Type",
    "Authorization",
    "PAYMENT-SIGNATURE",
    "X-Payment-Proof",
    "X-Unbrowse-Trace-Version",
    "X-Unbrowse-Code-Hash",
    "X-Unbrowse-Git-Sha",
    "X-Unbrowse-Release-Manifest",
    "X-Unbrowse-Release-Signature",
  ],
  exposeHeaders: ["PAYMENT-REQUIRED", "PAYMENT-RESPONSE", "X-Payment-Required"],
  maxAge: 86400,
}));

// Route registration. Some routers keep public reads and protected writes inline.
app.route("/", healthRoutes);
// Admin routes mount FIRST so adminRoutes-owned paths (e.g. /v1/analytics/payments)
// win Hono's first-match dispatch over analyticsRoutes' wildcard /analytics/*
// bearerAuth middleware. Admin endpoints use ADMIN_KEY, not API_KEY.
app.route("/v1", adminRoutes);
app.route("/v1", publicStatsRoutes);
app.route("/v1", searchRoutes);
app.route("/v1", publicSkillRoutes);
app.route("/v1", analyticsRoutes);
// Universal x402-gated LLM proxy (Stripe x402 -> xgate.run upstream + 50% markup).
// Additive to the existing Faremeter Flex/Solana skill routes; both coexist.
app.route("/v1/llm", llmRoutes);
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
app.route("/v1", publicMinerRoutes);
app.route("/v1", contractRoutes);
app.route("/v1", provisionPodRoutes);
app.route("/v1", openaiToolsRoutes);
app.route("/v1", extractRoutes);
app.route("/v1", blogRoutes);
app.route("/v1", landingRoutes);
app.route("/v1", webhookRoutes);
app.route("/v1", creditRoutes);
app.route("/v1", billingRoutes);
app.route("/v1", authRoutes);
app.route("/v1", claimRoutes);
app.route("/v1", accountRoutes);
app.route("/v1", cookieRoutes);
app.route("/", proxyRoutes);

// Issue routes with inline auth (POST/PATCH require auth, GET is public above)
app.route("/v1", issueRoutes);

// Additional protected routes use inline route-level auth so public GET routes stay open.
app.route("/v1", skillRoutes);
app.route("/v1", statsRoutes);
app.route("/v1", dashboardRoutes);

// Plan-v15 Tier 3: synthetic CF/PX challenge fixtures for CI bench.
// Public test fixture — no auth gate (anyone can reproduce the bench), but
// rate-limited inside the router. Path is /v1/test/* (not /v1/internal/*)
// so the URL doesn't falsely imply a protected surface.
app.route("/v1/test", syntheticRoutes);

// Wave 3: env-flagged `@faremeter/middleware` test route at /v1/test/paid.
// OFF by default; flip FAREMETER_ENABLED=1 to emit 402 with payment
// requirements. Uses the stub handler from routes/faremeter-test.ts —
// no real Solana settlement happens. See PR #572, #582 and this PR for
// the full wave history.
mountFaremeterTestRoute(app, {
  handlers: stubFaremeterHandlers,
  pricing: stubFaremeterPricing,
});

export { app };

export default {
  fetch: app.fetch,
  scheduled: async (_controller: ScheduledController, env: Env, ctx: ExecutionContext) => {
    ctx.waitUntil(flushQueuedGithubNotifications(env));
    ctx.waitUntil(
      import("./jobs/triage-telemetry.js").then(({ runTelemetryTriage }) =>
        runTelemetryTriage(env).then(
          (r) => console.log("[triage-telemetry]", JSON.stringify(r)),
          (e) => console.error("[triage-telemetry] failed:", e instanceof Error ? e.message : String(e)),
        ),
      ),
    );
  },
};
