import { Hono, type Context } from "hono";
import type { Env } from "../types.js";
import { bearerAuth } from "../middleware/auth.js";
import { rateLimit } from "../middleware/rate-limit.js";
import {
  createCheckoutSession,
  createPortalSession,
  getOrCreateCustomer,
  processBillingEvent,
  readSubFromKV,
  syncStripeDataToUserKV,
  verifyWebhookSignature,
} from "../services/stripe.js";
import {
  activateCryptoSubscription,
  assertNoStripeConflict,
  loadIntent,
  newCryptoSubIntent,
  planFromParam,
  priceIdForPlan,
  quoteForPlan,
  saveIntent,
  INTENT_TTL_SECONDS,
  PAID_INTENT_TTL_SECONDS,
} from "../services/crypto-sub.js";
import { getAgent } from "../services/agents.js";
import { x402UseTestnet } from "../middleware/x402-gate.js";
import { checkFlexOnboarding } from "../middleware/flex-onboarding-required.js";

type BillingEnv = { Bindings: Env; Variables: { agent_id: string; user_id?: string } };
export const billingRoutes = new Hono<BillingEnv>();

billingRoutes.use("/billing/*", rateLimit({ limit: 30, window: 60, prefix: "billing" }));

type RoadblockKind =
  | "flex_onboarding_required"
  | "mainnet_facilitator_unavailable"
  | "wallet_balance_low";

interface TopupNeededBody {
  requested_network?: string;
  min_balance_uc?: number | string;
  wallet_balance_uc?: number | string;
  amount_usd?: number | string;
  return_url?: string;
}

function parseNonNegativeInteger(value: unknown): number | null {
  if (value == null || value === "") return null;
  const parsed =
    typeof value === "number"
      ? value
      : typeof value === "string"
        ? Number.parseInt(value, 10)
        : Number.NaN;
  if (!Number.isFinite(parsed) || parsed < 0) return null;
  return Math.floor(parsed);
}

function parsePositiveUsd(value: unknown): number {
  const parsed =
    typeof value === "number"
      ? value
      : typeof value === "string"
        ? Number.parseFloat(value)
        : Number.NaN;
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 5;
}

function wantsMainnet(value: string | undefined): boolean {
  const raw = value?.trim().toLowerCase();
  return raw === "mainnet" || raw === "solana-mainnet" || raw === "solana:mainnet";
}

function providerCommand(provider: string | null, amountUsd: number): string {
  switch (provider) {
    case "pay_sh":
      return `pay topup --amount ${amountUsd}`;
    case "lobster_cash":
    case "lobster.cash":
      return `lobstercash topup --amount ${amountUsd}`;
    default:
      return `/contract topup --amount ${amountUsd}`;
  }
}

function buildRoadblockResponse(opts: {
  agentId: string;
  provider: string | null;
  kind: RoadblockKind | null;
  amountUsd: number;
  requestedNetwork: string;
  currentNetwork: "solana-mainnet" | "solana-testnet";
  minBalanceUc: number | null;
  walletBalanceUc: number | null;
  returnUrl?: string;
}) {
  const setupUrl = "https://lobster.cash/install";
  const checkoutUrl = opts.returnUrl?.trim() || "https://lobster.cash/login";
  const command = opts.kind === "flex_onboarding_required"
    ? "unbrowse setup"
    : providerCommand(opts.provider, opts.amountUsd);
  const renderHints = [
    {
      client: "telegram",
      kind: "button",
      label: opts.kind === "flex_onboarding_required" ? "Set up wallet" : "Top up",
      url: opts.kind === "flex_onboarding_required" ? setupUrl : checkoutUrl,
    },
    {
      client: "web",
      kind: "checkout_url",
      url: opts.kind === "flex_onboarding_required" ? setupUrl : checkoutUrl,
      provider: "lobster.cash",
    },
    {
      client: "terminal",
      kind: "command",
      command,
    },
  ];

  return {
    roadblock_required: opts.kind !== null,
    roadblock: opts.kind,
    agent_id: opts.agentId,
    payment_provider: opts.provider,
    requested_network: opts.requestedNetwork,
    current_network: opts.currentNetwork,
    min_balance_uc: opts.minBalanceUc,
    wallet_balance_uc: opts.walletBalanceUc,
    amount_usd: opts.amountUsd,
    next_step: opts.kind
      ? command
      : "No payment roadblock detected from the supplied network and balance signals.",
    requirement_block: opts.kind
      ? {
          kind: "ROADBLOCK REQUIRED",
          reason: opts.kind,
          render_hints: renderHints,
        }
      : null,
    render_hints: renderHints,
  };
}

async function readTopupNeededInput(c: Context<BillingEnv>): Promise<TopupNeededBody> {
  const query = c.req.query() as Record<string, string>;
  if (c.req.method.toUpperCase() !== "POST") return query;
  const body = await c.req.json<TopupNeededBody>().catch(() => ({}));
  return { ...query, ...body };
}

async function handleTopupNeeded(c: Context<BillingEnv>): Promise<Response> {
  const agentId = c.get("agent_id");
  if (!agentId) return c.json({ error: "agent_required" }, 401);

  const input = await readTopupNeededInput(c);
  const profile = agentId === "__admin__" ? null : await getAgent(c.env, agentId).catch(() => null);
  const provider = profile?.wallet_provider?.trim() || null;
  const requestedNetwork = input.requested_network?.trim() || "solana-mainnet";
  const currentNetwork = x402UseTestnet(c.env) ? "solana-testnet" : "solana-mainnet";
  const minBalanceUc = parseNonNegativeInteger(input.min_balance_uc);
  const walletBalanceUc = parseNonNegativeInteger(input.wallet_balance_uc);
  const amountUsd = parsePositiveUsd(
    input.amount_usd ?? (minBalanceUc == null ? undefined : String(minBalanceUc / 1_000_000)),
  );

  let kind: RoadblockKind | null = null;
  if (profile) {
    const onboarding = checkFlexOnboarding(profile);
    if (!onboarding.ready) kind = "flex_onboarding_required";
  }
  if (!kind && wantsMainnet(requestedNetwork) && currentNetwork !== "solana-mainnet") {
    kind = "mainnet_facilitator_unavailable";
  }
  if (!kind && minBalanceUc != null && walletBalanceUc != null && walletBalanceUc < minBalanceUc) {
    kind = "wallet_balance_low";
  }

  const body = buildRoadblockResponse({
    agentId,
    provider,
    kind,
    amountUsd,
    requestedNetwork,
    currentNetwork,
    minBalanceUc,
    walletBalanceUc,
    returnUrl: input.return_url,
  });

  if (!kind) return c.json(body);
  return c.json(body, 402, {
    "X-Roadblock-Required": "1",
    "X-Roadblock-Reason": kind,
  });
}

// GET/POST /v1/billing/topup-needed — structured ROADBLOCK REQUIRED surface.
billingRoutes.get("/billing/topup-needed", bearerAuth, handleTopupNeeded);
billingRoutes.post("/billing/topup-needed", bearerAuth, handleTopupNeeded);

// POST /v1/billing/checkout — returns { url } to Stripe Checkout
billingRoutes.post("/billing/checkout", bearerAuth, async (c) => {
  const userId = c.get("user_id");
  if (!userId) return c.json({ error: "user_required" }, 401);
  const body = await c.req
    .json<{ return_url?: string; tier?: "pro" | "metered" | "base"; price_id?: string }>()
    .catch(() => ({}) as { return_url?: string; tier?: "pro" | "metered" | "base"; price_id?: string });
  const returnUrl = body.return_url ?? `${c.env.PUBLIC_FRONTEND_URL ?? "https://unbrowse.ai"}/billing/success`;
  const email = ((c.get as unknown as (k: string) => string | undefined)("email")) ?? `${userId}@users.unbrowse.ai`;
  try {
    // price_id wins when present (a declared plan such as AikoNotch Pro,
    // whose grant rides in the Stripe Price metadata); tier is the legacy
    // env-keyed fallback.
    const result = await createCheckoutSession(c.env, userId, email, returnUrl, {
      priceId: body.price_id,
      tier: body.tier,
    });
    return c.json(result);
  } catch (err) {
    console.error("[billing/checkout]", (err as Error).message);
    return c.json({ error: "checkout_failed", message: (err as Error).message }, 500);
  }
});

// GET /v1/billing/success?session_id=cs_... — eager sync, returns sub
billingRoutes.get("/billing/success", bearerAuth, async (c) => {
  const userId = c.get("user_id");
  if (!userId) return c.json({ error: "user_required" }, 401);
  try {
    const sub = await readSubFromKV(c.env, userId);
    if (!sub) return c.json({ status: "none", note: "no customer record yet — webhook may still be in flight" });
    // Eagerly resync to handle the race vs webhook (Theo's protocol).
    // getOrCreateCustomer is idempotent and returns the customerId without creating duplicates.
    const customerId = await getOrCreateCustomer(c.env, userId, `${userId}@users.unbrowse.ai`);
    const fresh = await syncStripeDataToUserKV(c.env, customerId);
    return c.json(fresh);
  } catch (err) {
    return c.json({ error: "sync_failed", message: (err as Error).message }, 500);
  }
});

// POST /v1/billing/webhook — signature-verified (no bearerAuth)
billingRoutes.post("/billing/webhook", async (c) => {
  const signature = c.req.header("stripe-signature");
  if (!signature) return c.json({ error: "missing_signature" }, 400);
  const rawBody = await c.req.text();
  try {
    const event = await verifyWebhookSignature(c.env, rawBody, signature);
    await processBillingEvent(c.env, event);
    return c.json({ received: true });
  } catch (err) {
    console.error("[billing/webhook]", (err as Error).message);
    return c.json({ error: "invalid_signature", message: (err as Error).message }, 400);
  }
});

// GET /v1/billing/portal — { url }
billingRoutes.get("/billing/portal", bearerAuth, async (c) => {
  const userId = c.get("user_id");
  if (!userId) return c.json({ error: "user_required" }, 401);
  const returnUrl = `${c.env.PUBLIC_FRONTEND_URL ?? "https://unbrowse.ai"}/billing`;
  try {
    const { url } = await createPortalSession(c.env, userId, returnUrl);
    return c.json({ url });
  } catch (err) {
    return c.json({ error: "portal_failed", message: (err as Error).message }, 500);
  }
});

// GET /v1/billing/me — returns current STRIPE_SUB_CACHE
billingRoutes.get("/billing/me", bearerAuth, async (c) => {
  const userId = c.get("user_id");
  if (!userId) return c.json({ error: "user_required" }, 401);
  try {
    const sub = await readSubFromKV(c.env, userId);
    return c.json(sub ?? { status: "none" });
  } catch (err) {
    return c.json({ error: "read_failed", message: (err as Error).message }, 500);
  }
});

// ──────────────────────────────────────────────────────────────────────────
// Crypto subscription (monthly USDC) — contract organ 1682152a stage B.
// Ported from aiko-v2's `aiko-api-worker/src/crypto-sub.ts` so unbrowse is
// the single source of truth for ALL payment shapes. Aiko's worker is now
// a client of these routes; see `docs/internal/aiko-payment-consolidation-audit.md`.
//
// The actual x402 verification on the payment is delegated to the existing
// flex-payment-terms / x402-gate middleware ladder; these routes carry the
// intent + activation logic. Wire x402 enforcement on POST /crypto-sub/* in
// the same wave the runtime decides whether to gate per-route or per-intent.
// ──────────────────────────────────────────────────────────────────────────

// GET /v1/billing/crypto-sub/:plan/quote — public price quote, no auth
billingRoutes.get("/billing/crypto-sub/:plan/quote", (c) => {
  const plan = planFromParam(c.req.param("plan"));
  if (!plan) return c.json({ error: "unknown_plan", hint: "use base or pro" }, 404);
  return c.json(quoteForPlan(c.env, plan));
});

// POST /v1/billing/crypto-sub/:plan/intent — auth'd intent creation
billingRoutes.post("/billing/crypto-sub/:plan/intent", bearerAuth, async (c) => {
  const userId = c.get("user_id");
  if (!userId) return c.json({ error: "user_required" }, 401);
  const plan = planFromParam(c.req.param("plan"));
  if (!plan) return c.json({ error: "unknown_plan" }, 404);
  const priceId = priceIdForPlan(c.env, plan);
  if (!priceId) return c.json({ error: `server_misconfigured`, message: `STRIPE_PRICE_${plan.toUpperCase()} not set` }, 503);

  const conflict = await assertNoStripeConflict(c.env, userId);
  if (conflict) return c.json({ error: conflict.kind, message: conflict.message }, 409);

  const intent = newCryptoSubIntent(c.env, { userId, plan, priceId });
  await saveIntent(c.env, intent, { ttlSeconds: INTENT_TTL_SECONDS });
  return c.json({
    ok: true,
    intentId: intent.id,
    status: intent.status,
    expiresAt: intent.expiresAt,
    quote: quoteForPlan(c.env, plan),
  });
});

// GET /v1/billing/crypto-sub/intent/:intentId — read intent status
billingRoutes.get("/billing/crypto-sub/intent/:intentId", bearerAuth, async (c) => {
  const userId = c.get("user_id");
  if (!userId) return c.json({ error: "user_required" }, 401);
  const intentId = c.req.param("intentId") ?? "";
  if (!intentId) return c.json({ error: "intent_not_found" }, 404);
  const intent = await loadIntent(c.env, intentId);
  if (!intent || intent.userId !== userId) return c.json({ error: "intent_not_found" }, 404);
  return c.json({
    ok: true,
    intentId: intent.id,
    plan: intent.plan,
    status: intent.status,
    currentPeriodEnd: intent.currentPeriodEnd,
    expiresAt: intent.expiresAt,
    quote: quoteForPlan(c.env, intent.plan),
  });
});

// POST /v1/billing/crypto-sub/:plan/activate — auth'd direct activation
// (Use this after x402 verification has been performed upstream. For
// per-intent payment flows, use POST /v1/billing/crypto-sub/pay/:intentId.)
billingRoutes.post("/billing/crypto-sub/:plan/activate", bearerAuth, async (c) => {
  const userId = c.get("user_id");
  if (!userId) return c.json({ error: "user_required" }, 401);
  const plan = planFromParam(c.req.param("plan"));
  if (!plan) return c.json({ error: "unknown_plan" }, 404);
  const priceId = priceIdForPlan(c.env, plan);
  if (!priceId) return c.json({ error: "server_misconfigured", message: `STRIPE_PRICE_${plan.toUpperCase()} not set` }, 503);

  const conflict = await assertNoStripeConflict(c.env, userId);
  if (conflict) return c.json({ error: conflict.kind, message: conflict.message }, 409);

  const result = await activateCryptoSubscription(c.env, { userId, plan, priceId });
  return c.json({
    ok: true,
    plan,
    customerId: result.customerId,
    currentPeriodEnd: result.cache.currentPeriodEnd,
    quota: result.cache.quota,
  });
});

// POST /v1/billing/crypto-sub/pay/:intentId — settle an intent, activate sub
billingRoutes.post("/billing/crypto-sub/pay/:intentId", bearerAuth, async (c) => {
  const userId = c.get("user_id");
  if (!userId) return c.json({ error: "user_required" }, 401);
  const intentId = c.req.param("intentId") ?? "";
  if (!intentId) return c.json({ error: "intent_not_found" }, 404);
  const intent = await loadIntent(c.env, intentId);
  if (!intent || intent.userId !== userId) return c.json({ error: "intent_not_found" }, 404);
  const now = Math.floor(Date.now() / 1000);
  if (intent.expiresAt < now) return c.json({ error: "intent_expired" }, 410);

  if (intent.status === "paid" && intent.currentPeriodEnd) {
    return c.json({
      ok: true,
      plan: intent.plan,
      currentPeriodEnd: intent.currentPeriodEnd,
      note: "already_paid",
    });
  }

  const conflict = await assertNoStripeConflict(c.env, intent.userId);
  if (conflict) return c.json({ error: conflict.kind, message: conflict.message }, 409);

  const result = await activateCryptoSubscription(c.env, {
    userId: intent.userId,
    plan: intent.plan,
    priceId: intent.priceId,
  });
  const paidIntent = {
    ...intent,
    status: "paid" as const,
    currentPeriodEnd: result.cache.currentPeriodEnd,
  };
  await saveIntent(c.env, paidIntent, { ttlSeconds: PAID_INTENT_TTL_SECONDS });

  return c.json({
    ok: true,
    plan: intent.plan,
    customerId: result.customerId,
    currentPeriodEnd: result.cache.currentPeriodEnd,
    quota: result.cache.quota,
  });
});
