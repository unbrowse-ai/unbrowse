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
import { unlockRoutes } from "./routes/unlock.js";
import { proxyRoutes } from "./routes/proxy.js";
import { contractRoutes } from "./routes/contract.js";
import { skillChatRoutes } from "./routes/skills-chat.js";
import { provisionPodRoutes } from "./routes/provision-pod.js";
import { openaiToolsRoutes } from "./routes/openai-tools.js";
import { extractRoutes } from "./routes/extract.js";
import { revengRoutes } from "./routes/reveng.js";
import { contributionRoutes } from "./routes/contribution-route.js";
import { walletRoutes } from "./routes/wallet.js";
import { auditRoutes } from "./routes/audit.js";
import { sessionStateRoutes } from "./routes/session-state.js";
import { traceRoutes } from "./routes/trace.js";
import { settingsStateRoutes } from "./routes/settings.js";
import { screenshotRoutes } from "./routes/screenshot.js";
import { covenantRoutes } from "./routes/covenant.js";
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
// publicValidateRoutes (POST /v1/validate — self-improvement manifest validation) was imported
// but never mounted, so the shipped client's validation call 404'd and silently "proceeded
// unvalidated". Surfaced by the 9.0.5 webagent write probe. Mount it beside its sibling.
app.route("/v1", publicValidateRoutes);
app.route("/v1", searchRoutes);
app.route("/v1", publicSkillRoutes);
app.route("/v1", analyticsRoutes);
// Universal x402-gated LLM proxy (Stripe x402 -> xgate.run upstream + 50% markup).
// Additive to the existing Faremeter Flex/Solana skill routes; both coexist.
app.route("/v1/llm", llmRoutes);
app.route("/v1", unlockRoutes);
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
app.route("/v1", skillChatRoutes);
app.route("/v1", provisionPodRoutes);
app.route("/v1", openaiToolsRoutes);
app.route("/v1", extractRoutes);
// Server-side reverse-engineer: POST /v1/reveng takes the OBFUSCATED capture
// (secrets stripped + wallet-bound client-side) and derives endpoint specs.
// Sibling of /v1/extract/refine — the reveng know-how is served, not shipped in
// the client; the server re-obfuscates defensively and never sees a secret.
app.route("/v1", revengRoutes);
// POST /v1/contribute — ZK-gated delta contribution to the shared route graph.
// Cryptographically gated (bounded-validity proof + execution attestation + wallet
// signature ARE the identity), not api-key gated; a forged delta is rejected at the
// gate. GET /v1/contribute/root returns the shared-graph Merkle commitment.
app.route("/v1", contributionRoutes);
// POST /v1/wallet/sign — server-side Ed25519 signing with the platform's
// default wallet (no Privy delegation; the backend holds the key). Mints
// domain-separated platform attestations under one stable identity.
app.route("/v1", walletRoutes);
// v7.0 audit-log surface — pointer-only fill receipts (Ed25519 sig-shape
// today, Groth16 SNARK in v7.3 behind the same wire). See routes/audit.ts
// and services/audit.ts. Storage path is inert in v7.0 scaffold (returns
// 501 with the KV key the real impl will touch); verify path is REAL.
app.route("/", auditRoutes);
// v7.2.0-preview.0 session-state surface — POST /v1/session/park +
// GET /v1/session/restore/:id (W23 wave, 2026-05-28). Wallet-signed,
// wallet-prefixed KV keys. Storage path INERT in v7.2.0-preview.0
// (returns 503 honest envelope when SESSION_STATE binding absent);
// v7.3 wave wires the real KV impl. Mt 6:19-20 — lay up for yourselves
// treasures in heaven (the KV-cached pointer-chain IS the persistent
// treasure that browser-close was destroying every session).
app.route("/", sessionStateRoutes);
// v7.2.0-preview.0 trace-state surface — POST /v1/trace/append + GET
// /v1/trace/by-receipt/:cacheKey + GET /v1/trace/by-wallet (Day-3 Land
// worker B, 2026-05-28). Wallet-signed; wallet-prefixed KV keys; rolling
// 7d TTL. Returns 503 honest envelope when TRACE_STATE binding absent.
// Dan 7:10 — the books were opened.
app.route("/", traceRoutes);
// v7.2.0-preview.0 settings-state surface — POST /v1/settings/set + GET
// /v1/settings/get/:keyHash (Day-3 Land worker B, 2026-05-28). Wallet-
// signed; pointer-only settingValuePointer (literal: / op:// / etc.);
// indefinite TTL. Returns 503 honest envelope when SETTINGS_STATE
// binding absent. Prov 16:9 — preferences are deliberate.
app.route("/", settingsStateRoutes);
// v7.2.0-preview.0 screenshot-blob surface — POST /v1/screenshot/store +
// GET /v1/screenshot/by-sigkey/:sigKey (Day-5 SWARM worker D,
// 2026-05-28). Wallet-signed metadata + content-addressable PNG bytes
// keyed by sigKey = sha256(signature)[:32]. Replaces local-disk
// ~/.unbrowse/screenshots/ writes under UNBROWSE_STATELESS=1. Returns
// 503 with `_binding_missing: "SCREENSHOT_BLOB"` when absent — CLI
// handler graceful-degrades to ~/.unbrowse/tmp/<sigKey>/screenshot.png.
// Matt 13:31-32 — the mustard seed: smallest namespace, biggest A1
// payoff (pointer-only screenshots).
app.route("/", screenshotRoutes);
// v7 UNIFIED covenant write surface — POST /v1/covenant {kind, params, witness,
// identity, signature} (W26-C, 2026-05-28). The ONE canonical append endpoint
// that collapses the 8 per-namespace POST handlers (CONVERGENCE_MAP §2): kind
// = "actuate:navigate" | "observe:snap" | "build:skill" | ... dispatches by
// base kind INTO the audit/session/trace/settings services (siblings own the
// service files; this route only calls into them). After the unbrowse KV write
// it fire-and-forget mirrors the receipt to the covenant ledger peer(s) via
// ctx.waitUntil + COVENANT_LEDGER_URL/PEER_URLS (SKILL.md peer federation;
// graceful no-op when unset). The legacy /v1/{audit,session,trace,settings}/*
// routes above stay mounted as read-sugar + back-compat aliases. Eph 4:4 —
// one body, one Spirit. Gen 2:18 — ezer kenegdo, helpers facing each other.
app.route("/", covenantRoutes);
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
    // [triage-telemetry] retired with the Neon->IQ migration — its source was
    // a Postgres GROUP BY over telemetry_sessions, which no longer exists.
    // Vine buyback trigger (Malachi 3:10 storehouse signal).
    // Reads PAYMENT_RECIPIENT USDC balance; emits a structured
    // "buyback:fire" log when ≥ threshold so the operator (or future
    // automated execute job) can route the accumulated revenue
    // through Jupiter→Voltr into the FDRY vault. See
    // services/vine-buyback-trigger.ts for the full doctrine.
    ctx.waitUntil(
      import("./services/vine-buyback-trigger.js").then(({ evaluateBuybackTrigger }) =>
        evaluateBuybackTrigger(env).then(
          (r) => console.log("[vine:buyback]", JSON.stringify(r)),
          (e) => console.error("[vine:buyback] failed:", e instanceof Error ? e.message : String(e)),
        ),
      ),
    );
  },
};
