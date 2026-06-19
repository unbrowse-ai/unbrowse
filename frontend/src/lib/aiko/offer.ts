/* Aiko early-bird offer — pricing + the live Stripe checkout link.
 *
 * Pricing sourced from the live aiko-v4-lite site: $200/mo regular, sold at a
 * 50%-off early-bird price of $100/mo. The Payment Link is created in the real
 * Foundry Stripe account (acct_1Ruu6U…) and is a PUBLIC URL — safe to ship.
 *
 * To go LIVE: set NEXT_PUBLIC_AIKO_PAYMENT_LINK to the live Payment Link URL.
 * The default below is the verified TEST-mode link (a working checkout) so the
 * button is never dead before the live key is provisioned. Flip the env var and
 * the whole site charges live — no code change. */

export const AIKO_PRICE = {
  regularMonthly: 200,
  earlyBirdMonthly: 100,
  discountPct: 50,
  currency: "USD",
} as const;

const TEST_PAYMENT_LINK = "https://buy.stripe.com/test_3cIeVe8HH8mvbGU5sSbbG08";

/** Public Stripe Payment Link for the $100/mo early-bird price. */
export function getAikoCheckoutUrl(): string {
  const env = process.env.NEXT_PUBLIC_AIKO_PAYMENT_LINK?.trim();
  return env && env.length > 0 ? env : TEST_PAYMENT_LINK;
}

/** True when the live link is wired (env set to a non-test buy.stripe.com URL). */
export function isAikoCheckoutLive(): boolean {
  const url = getAikoCheckoutUrl();
  return url.startsWith("https://buy.stripe.com/") && !url.includes("/test_");
}
