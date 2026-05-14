import { Hono, type Context } from "hono";
import type { Env } from "../types.js";
import { bearerAuth } from "../middleware/auth.js";
import { agentRateLimit } from "../middleware/rate-limit.js";
import {
  runDemoPipeline,
  getJob,
  putJob,
  type DemoRequest,
  type DemoJob,
} from "../services/demo-pipeline.js";
import {
  x402Response,
  verifyX402Proof,
  buildSkillPaymentTerms,
  paymentsEnabled,
  x402UseTestnet,
} from "../middleware/x402-gate.js";
import { recordTransaction } from "../services/transactions.js";

type DemoEnv = { Bindings: Env; Variables: { agent_id: string; user_id?: string } };

export const demoRoutes = new Hono<DemoEnv>();

function schedule(c: Context, task: Promise<unknown>): void {
  try {
    (c as Context & { executionCtx: ExecutionContext }).executionCtx.waitUntil(task);
  } catch {
    void task;
  }
}

/** Map tier name to USD price */
const TIER_PRICES: Record<string, number> = {
  basic: 0.5,
  standard: 1.0,
  premium: 2.0,
};

// Auth on all demo routes
demoRoutes.use("/demos/*", bearerAuth);

// Rate limit: 5 demo generations per hour per agent
demoRoutes.use(
  "/demos/generate",
  agentRateLimit({ limit: 5, window: 3600, prefix: "demo-gen" }),
);

// POST /v1/demos/generate — kick off a demo video generation job
demoRoutes.post("/demos/generate", async (c) => {
  const agentId = c.get("agent_id");
  const body = await c.req.json<DemoRequest>();

  // Validate required field
  if (!body.repo_url?.trim()) {
    return c.json({ error: "repo_url is required" }, 400);
  }

  // Validate enum fields if present
  if (body.voice && !["minimax", "elevenlabs", "espeak"].includes(body.voice)) {
    return c.json({ error: "voice must be one of: minimax, elevenlabs, espeak" }, 400);
  }
  if (body.aspect_ratio && !["16:9", "9:16"].includes(body.aspect_ratio)) {
    return c.json({ error: "aspect_ratio must be one of: 16:9, 9:16" }, 400);
  }
  if (body.tier && !["basic", "standard", "premium"].includes(body.tier)) {
    return c.json({ error: "tier must be one of: basic, standard, premium" }, 400);
  }

  // ── x402 payment gate (optional — skipped when PAYMENTS_ENABLED is falsy) ──
  const tier = body.tier ?? "basic";
  const priceUsd = TIER_PRICES[tier] ?? TIER_PRICES.basic;

  if (paymentsEnabled(c.env) && priceUsd > 0) {
    // Subscription admission lane (parallel to x402). If the caller's bearer
    // key resolves to a user with an active subscription, admit. F1: no user /
    // no sub falls through to x402 below.
    const { subscriptionAdmits, recordUsage } = await import("../services/stripe.js");
    const admit = await subscriptionAdmits(c.env, c).catch((err) => {
      console.warn("[admission] subscriptionAdmits threw, falling through to x402:", (err as Error).message);
      return { admit: false as const, reason: "no_user" as const };
    });
    const admittedViaSub = admit.admit;
    if (admittedViaSub) {
      const uid = c.get("user_id");
      if (admit.reason !== "admit_admin" && uid) {
        await recordUsage(c.env, uid, 1).catch((err) =>
          console.warn("[admission] recordUsage failed (admitted anyway):", (err as Error).message),
        );
      }
      c.header(
        "X-Unbrowse-Billing",
        `${admit.reason === "admit_overage" ? "overage" : admit.reason === "admit_admin" ? "admin" : "subscription"} consumed=${admit.consumed ?? 0}/${admit.quota ?? 0}`,
      );
    }

    if (!admittedViaSub) {
    const paymentHeader = c.req.header("PAYMENT-SIGNATURE");
    const legacyProofHeader = c.req.header("X-Payment-Proof");
    let sponsoredAdmit = false;

    if (!paymentHeader && !legacyProofHeader) {
      // No proof provided — sponsor check first, then 402
      const recipient = c.env.PAYMENT_RECIPIENT ?? "";
      const terms = await buildSkillPaymentTerms(
        priceUsd,
        `demo-video-${tier}`,
        recipient,
        c.req.url,
        { testnet: x402UseTestnet(c.env) },
      );
      // Override the description to be demo-specific
      terms.resource.description = `Demo video generation (${tier} tier)`;

      // Sponsor decision (only for authenticated, non-admin agents).
      if (agentId && agentId !== "__admin__") {
        const { maybeSponsor } = await import("../middleware/sponsor.js");
        const decision = await maybeSponsor(c, terms.accepts, agentId);
        if (decision.kind === "sponsored") {
          c.header("X-Sponsored", decision.ledger_id);
          c.header("X-Sponsor-Tx", decision.tx_hash);
          c.header("X-Sponsor-Remaining-Usd", decision.remaining_credit_usd.toFixed(6));
          sponsoredAdmit = true;
        } else if (decision.kind === "exhausted") {
          c.header("X-Sponsor-Exhausted", "1");
          c.header("X-Sponsor-Reason", decision.reason);
          c.header("X-Sponsor-Remaining-Usd", decision.remaining_credit_usd.toFixed(6));
          return x402Response(c, terms);
        } else {
          c.header("X-Sponsor-Reason", "opted_out");
          return x402Response(c, terms);
        }
      } else {
        return x402Response(c, terms);
      }
    }

    if (!sponsoredAdmit) {
    // Proof provided — verify via Corbits facilitator
    const proof = paymentHeader ?? legacyProofHeader!;
    const { valid, degraded, transaction, settlementHeader } = await verifyX402Proof(proof);
    if (!valid) {
      return c.json({ error: "Payment proof invalid or rejected" }, 403);
    }
    if (degraded) {
      console.warn(`[x402] facilitator down — allowed degraded access for demo ${tier}`);
    }
    if (settlementHeader) {
      c.header("PAYMENT-RESPONSE", settlementHeader);
    }

    // Record to ledger (non-blocking)
    const txId = transaction ?? `x402-${Date.now()}-demo-${tier}`;
    schedule(c, recordTransaction(c.env, {
      transaction_id: txId,
      consumer_id: agentId ?? "anonymous",
      creator_id: c.env.PAYMENT_RECIPIENT,
      skill_id: `demo-video-${tier}`,
      price_usd: priceUsd,
      payment_proof: proof,
    }).catch((err) => console.warn(`[x402] ledger write failed: ${(err as Error).message}`)));
    }
    }
  }

  // Create job
  const jobId = crypto.randomUUID();
  const job: DemoJob = {
    job_id: jobId,
    agent_id: agentId,
    status: "queued",
    created_at: new Date().toISOString(),
    request: body,
  };

  await putJob(c.env, job);

  // Fire-and-forget pipeline via waitUntil
  try {
    c.executionCtx.waitUntil(runDemoPipeline(c.env, jobId, body));
  } catch {
    // Fallback for environments without executionCtx (tests, etc.)
    void runDemoPipeline(c.env, jobId, body);
  }

  return c.json(
    {
      job_id: jobId,
      status: "queued",
      status_url: `/v1/demos/${jobId}`,
    },
    202,
  );
});

// GET /v1/demos/:job_id — poll job status
demoRoutes.get("/demos/:job_id", async (c) => {
  const agentId = c.get("agent_id");
  const jobId = c.req.param("job_id");

  const job = await getJob(c.env, jobId);
  if (!job) {
    return c.json({ error: "Job not found" }, 404);
  }

  // Only the creating agent (or admin) can read the job
  if (agentId !== "__admin__" && job.agent_id !== agentId) {
    return c.json({ error: "Job not found" }, 404);
  }

  return c.json({
    job_id: job.job_id,
    status: job.status,
    created_at: job.created_at,
    outputs: job.outputs ?? null,
    cost_cents: job.cost_cents ?? null,
    error: job.error ?? null,
  });
});
