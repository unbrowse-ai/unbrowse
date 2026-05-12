import { Hono } from "hono";
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

type BillingEnv = { Bindings: Env; Variables: { agent_id: string; user_id?: string } };
export const billingRoutes = new Hono<BillingEnv>();

billingRoutes.use("/billing/*", rateLimit({ limit: 30, window: 60, prefix: "billing" }));

// POST /v1/billing/checkout — returns { url } to Stripe Checkout
billingRoutes.post("/billing/checkout", bearerAuth, async (c) => {
  const userId = c.get("user_id");
  if (!userId) return c.json({ error: "user_required" }, 401);
  const body = await c.req.json<{ return_url?: string }>().catch(() => ({} as { return_url?: string }));
  const returnUrl = body.return_url ?? `${c.env.PUBLIC_FRONTEND_URL ?? "https://unbrowse.ai"}/billing/success`;
  const email = ((c.get as unknown as (k: string) => string | undefined)("email")) ?? `${userId}@users.unbrowse.ai`;
  try {
    const { url } = await createCheckoutSession(c.env, userId, email, returnUrl);
    return c.json({ url });
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
