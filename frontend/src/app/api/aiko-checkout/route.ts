/* POST /api/aiko-checkout — create a LIVE Stripe Checkout Session for the Aiko
 * early-bird subscription ($100/mo, charged upfront), then return its URL for
 * the client to redirect to. Server-side only: the Stripe key (a restricted
 * live key) lives as a Worker secret and never reaches the browser.
 *
 * Raw REST (no SDK) so it stays Workers-clean, mirroring the app's other routes. */

import { getCloudflareContext } from "@opennextjs/cloudflare";

export const runtime = "nodejs";
export const maxDuration = 20;

// The live $100/mo recurring price created in the Foundry account. Overridable
// by env for rotation without a code change.
const DEFAULT_PRICE_ID = "price_1TjqEWJmoy2l93T2yO82YmZY";

function env(): Record<string, unknown> {
  try {
    return getCloudflareContext().env as unknown as Record<string, unknown>;
  } catch {
    return {};
  }
}

export async function POST(req: Request): Promise<Response> {
  const e = env();
  const key = (e.STRIPE_SECRET_KEY as string | undefined) ?? process.env.STRIPE_SECRET_KEY;
  const priceId = (e.AIKO_PRICE_ID as string | undefined) ?? process.env.AIKO_PRICE_ID ?? DEFAULT_PRICE_ID;

  if (!key || !priceId) {
    return Response.json({ error: "checkout is not configured yet" }, { status: 503 });
  }

  const origin = new URL(req.url).origin;
  const form = new URLSearchParams();
  form.set("mode", "subscription");
  form.set("line_items[0][price]", priceId);
  form.set("line_items[0][quantity]", "1");
  form.set("success_url", `${origin}/aiko?welcome=1`);
  form.set("cancel_url", `${origin}/aiko`);
  form.set("allow_promotion_codes", "true");

  let res: Response;
  try {
    res = await fetch("https://api.stripe.com/v1/checkout/sessions", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${key}`,
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: form.toString(),
    });
  } catch (err) {
    console.error(`[aiko-checkout] network error: ${(err as Error).message}`);
    return Response.json({ error: "could not reach checkout, please retry" }, { status: 502 });
  }

  const data = (await res.json().catch(() => ({}))) as { url?: string; error?: { message?: string } };
  if (!res.ok || !data.url) {
    console.error(`[aiko-checkout] stripe ${res.status}: ${data.error?.message ?? "no url"}`);
    return Response.json({ error: data.error?.message ?? "checkout error" }, { status: 502 });
  }

  return Response.json({ url: data.url });
}
