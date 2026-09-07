/* Aiko early-bird offer — pricing constants.
 *
 * $200/mo regular, sold at a 50%-off early-bird price of $100/mo, charged
 * upfront as a subscription. Checkout is created server-side in
 * src/app/api/aiko-checkout/route.ts (a live Stripe Checkout Session against
 * the Foundry account); the live price id lives there / in env. */

export const AIKO_PRICE = {
  regularMonthly: 200,
  earlyBirdMonthly: 100,
  discountPct: 50,
  currency: "USD",
} as const;

/** The live $100/mo recurring price created in the Foundry Stripe account. */
export const AIKO_LIVE_PRICE_ID = "price_1TjqEWJmoy2l93T2yO82YmZY";
