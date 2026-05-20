/**
 * Surface smoke test for the @faremeter/middleware dependency.
 *
 * Wave 2 of the integrate-abk-labs-fair-meter-faremeter-x402-pay scaffold:
 * Wave 1 was a documentation PR cataloguing the ABK Labs ecosystem. This is
 * the first scoped code wave. It asserts that the @faremeter/middleware
 * package declared in backend/package.json actually resolves, exports the
 * documented Hono + common surface, and emits a real 402 challenge for an
 * unpaid request through a fully in-process FacilitatorHandler stub.
 *
 * Why a smoke test and not a route rewrite: backend/src already runs
 * Faremeter Flex via the @faremeter/flex-solana + @faremeter/payment-solana
 * path. @faremeter/middleware is declared but not yet imported anywhere
 * under backend/src. This test pins the dependency contract so a future
 * wave can compose its Hono adapter into a real route without first
 * proving the import surface.
 *
 * No mocks of internal code, no network. The in-process handler stub
 * mirrors the DI seam backend/src/services/flex-facilitator.ts already
 * uses for unit tests.
 */

import { describe, test, expect } from "bun:test";
import { Hono } from "hono";
import { hono as faremeterHono, common as faremeterCommon } from "@faremeter/middleware";

describe("@faremeter/middleware surface (Wave 2 spike)", () => {
  test("hono subpath exports createMiddleware", () => {
    expect(typeof faremeterHono.createMiddleware).toBe("function");
  });

  test("common subpath exports the documented helpers", () => {
    expect(typeof faremeterCommon.validateMiddlewareArgs).toBe("function");
    expect(typeof faremeterCommon.resolveSupportedVersions).toBe("function");
    expect(typeof faremeterCommon.acceptsToPricing).toBe("function");
    expect(typeof faremeterCommon.deriveCapabilities).toBe("function");
    expect(typeof faremeterCommon.findMatchingPaymentRequirements).toBe("function");
  });

  test("resolveSupportedVersions defaults to x402v1 enabled", () => {
    const resolved = faremeterCommon.resolveSupportedVersions();
    expect(resolved.x402v1).toBe(true);
    expect(resolved.x402v2).toBe(false);
  });

  test("validateMiddlewareArgs accepts a remote facilitator config", () => {
    expect(() =>
      faremeterCommon.validateMiddlewareArgs({
        facilitatorURL: "https://facilitator.example.com",
        accepts: [
          {
            scheme: "exact",
            network: "solana-devnet",
            maxAmountRequired: "10000",
            payTo: "PlatformATAxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx",
            asset: "USDC",
            resource: "https://test/resource",
            description: "test",
            maxTimeoutSeconds: 60,
          },
        ],
      }),
    ).not.toThrow();
  });

  test("validateMiddlewareArgs rejects an empty config (no facilitator, no handlers)", () => {
    expect(() => faremeterCommon.validateMiddlewareArgs({})).toThrow();
  });

  test("Hono middleware returns 402 with payment requirements when X-PAYMENT is absent", async () => {
    // In-process FacilitatorHandler stub — no network. Mirrors the DI seam
    // backend/src/services/flex-facilitator.ts already uses for unit tests.
    const acceptKind = {
      x402Version: 2 as const,
      scheme: "exact",
      network: "solana-devnet",
    };
    const handlerStub = {
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
    };

    const middleware = await faremeterHono.createMiddleware({
      x402Handlers: [handlerStub as never],
      pricing: [
        {
          amount: "10000",
          asset: "USDC",
          recipient: "PlatformATAxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx",
          network: "solana-devnet",
          description: "Wave 2 spike paid resource",
        },
      ],
    });

    const app = new Hono();
    app.use("/paid", middleware);
    app.get("/paid", (c) => c.json({ ok: true, premium: "data" }));

    const res = await app.request("/paid", { method: "GET" });
    expect(res.status).toBe(402);
    const body = (await res.json()) as { accepts?: unknown };
    expect(body).toBeDefined();
    expect(Array.isArray(body.accepts)).toBe(true);
    expect((body.accepts as unknown[]).length).toBeGreaterThan(0);
  });
});
