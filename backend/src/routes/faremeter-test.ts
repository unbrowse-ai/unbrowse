/**
 * Behind-flag wiring of `@faremeter/middleware` against a real backend route.
 *
 * Wave 3 of the integrate-abk-labs-fair-meter-faremeter-x402-pay scaffold.
 *
 * Wave 1 (#572): docs/faremeter-integration-status.md catalogued the ABK Labs
 *   ecosystem and identified the gap — the package was declared but unused.
 * Wave 2 (#582): tests/faremeter-middleware-smoke.test.ts pinned the import
 *   surface (hono.createMiddleware, common helpers) so a future wave could
 *   wire it without first proving the import.
 * Wave 3 (this PR): wires the middleware into ONE real backend route behind
 *   `FAREMETER_ENABLED`, with a real round-trip test that hits the mounted
 *   Hono app via app.request and asserts the 402 / pass-through behaviour.
 *
 * Design constraints (carried from CLAUDE.md):
 *  - Behind env flag, OFF by default. Existing prod paths are not touched.
 *  - No real Solana mainnet calls. The route accepts a caller-supplied
 *    handler factory via `mountFaremeterTestRoute` so unit tests inject an
 *    in-process FacilitatorHandler stub and assert the 402 / pass-through
 *    contract without network. Production wiring (index.ts) passes the
 *    `stubFaremeterHandlers` from this file — the real Flex handler from
 *    `services/flex-facilitator.ts` is wave 4.
 *  - When the flag is OFF, the middleware short-circuits to a 503
 *    `faremeter_disabled` instead of running. The route entry itself is
 *    always registered so the surface area is statically introspectable.
 */

import { Hono } from "hono";
import { hono as faremeterHono } from "@faremeter/middleware";
import type { Env } from "../types.js";

/**
 * The minimal FacilitatorHandler shape `hono.createMiddleware` needs.
 *
 * We don't import `@faremeter/types`' FacilitatorHandler directly here so
 * tests can pass an in-process stub without dragging the full Solana
 * handler chain into the test fixture. Production code (wave 4) will pass
 * the real handler from `services/flex-facilitator.ts`.
 */
export type FaremeterHandlerFactory = (
  env: Env,
) => Parameters<typeof faremeterHono.createMiddleware>[0]["x402Handlers"];

/**
 * Pricing factory — same DI seam, same reason. Real Flex pricing in prod;
 * a deterministic devnet stub in tests.
 */
export type FaremeterPricingFactory = (
  env: Env,
) => Parameters<typeof faremeterHono.createMiddleware>[0]["pricing"];

export interface FaremeterTestRouteOptions {
  handlers: FaremeterHandlerFactory;
  pricing: FaremeterPricingFactory;
}

/**
 * Read the FAREMETER_ENABLED env var as a boolean. Accepts "1" or "true"
 * (case-insensitive). Anything else, including unset, is disabled.
 *
 * Standalone helper so the test can assert the flag parsing directly without
 * standing up the full Hono app.
 */
export function isFaremeterEnabled(env: Pick<Env, "FAREMETER_ENABLED">): boolean {
  const raw = env.FAREMETER_ENABLED;
  if (typeof raw !== "string") return false;
  const v = raw.trim().toLowerCase();
  return v === "1" || v === "true";
}

/**
 * Mount the faremeter test route onto a parent Hono app.
 *
 * Returns the parent app for chaining. The route is always registered;
 * when `FAREMETER_ENABLED` is OFF the middleware short-circuits to a 503
 * `faremeter_disabled` body so callers can distinguish "feature off" from
 * "route missing".
 *
 * When ON, `/v1/test/paid` is a paid GET that emits 402 with payment
 * requirements when `X-PAYMENT` is missing, and passes through to the
 * handler when payment is valid (per the injected handler stub).
 */
export function mountFaremeterTestRoute(
  app: Hono<{ Bindings: Env }>,
  opts: FaremeterTestRouteOptions,
): Hono<{ Bindings: Env }> {
  const sub = new Hono<{ Bindings: Env }>();

  sub.use("/paid", async (c, next) => {
    if (!isFaremeterEnabled(c.env)) {
      return c.json(
        { error: "faremeter_disabled", code: "FAREMETER_FLAG_OFF" },
        503,
      );
    }
    // Per-request: build the middleware with the current env's
    // handler/pricing factories. Workers cold-start anyway, and
    // createMiddleware is lightweight (no I/O).
    const middleware = await faremeterHono.createMiddleware({
      x402Handlers: opts.handlers(c.env),
      pricing: opts.pricing(c.env),
    });
    return middleware(c, next);
  });

  sub.get("/paid", (c) => {
    return c.json({
      ok: true,
      route: "faremeter_test_paid",
      paid_resource: "wave3_real_wireup",
      timestamp: new Date().toISOString(),
    });
  });

  app.route("/v1/test", sub);
  return app;
}

/**
 * Stub handler factory used by production wiring when FAREMETER_ENABLED=1
 * but no real Flex handler is plumbed yet. Emits a deterministic
 * solana-devnet `exact` requirement; verify/settle always return null so
 * any presented payment fails closed (no actual settlement happens).
 *
 * This exists so the env-flagged route is callable in prod-shape without
 * a real Solana keypair. Wave 4 replaces this with the Flex handler from
 * `services/flex-facilitator.ts`.
 */
export const stubFaremeterHandlers: FaremeterHandlerFactory = (_env) => {
  const acceptKind = {
    x402Version: 2 as const,
    scheme: "exact",
    network: "solana-devnet",
  };
  return [
    {
      capabilities: {
        schemes: ["exact"],
        networks: ["solana-devnet"],
        assets: ["USDC"],
      },
      getSupported: () => [Promise.resolve(acceptKind)],
      getRequirements: async (args: { accepts: unknown[] }) =>
        args.accepts as never,
      handleSettle: async () => null,
      handleVerify: async () => null,
    } as never,
  ];
};

export const stubFaremeterPricing: FaremeterPricingFactory = (env) => [
  {
    amount: "10000",
    asset: "USDC",
    // Reuse the PAYMENT_RECIPIENT envvar when set so the requirement is
    // wallet-correct in prod; fall back to a clearly-fake placeholder so
    // a misconfigured env never silently routes payments to a default.
    recipient:
      env.PAYMENT_RECIPIENT ?? "PlatformATAxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx",
    network: "solana-devnet",
    description: "faremeter wave 3 stub paid resource (devnet, no settlement)",
  },
];
