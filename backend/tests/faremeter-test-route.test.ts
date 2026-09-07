/**
 * Wave 3 round-trip test for the env-flagged `/v1/test/paid` faremeter route.
 *
 * Asserts the real route module wired into a full Hono app:
 *  - FAREMETER_ENABLED unset / "0" / "false": route returns 503
 *    faremeter_disabled (the always-mounted middleware short-circuit).
 *  - FAREMETER_ENABLED="1" + no X-PAYMENT: route returns 402 with
 *    `accepts` payment requirements array.
 *  - FAREMETER_ENABLED="true" (case-insensitive variant of the flag):
 *    same 402 behaviour.
 *  - isFaremeterEnabled flag parser: spot-check all the truthy/falsy
 *    variants so a future env-var refactor doesn't silently accept
 *    "yes" / "on" / "enabled" and surprise prod.
 *
 * Uses Hono's `app.request(...)` — no network, no real Solana, no mocks
 * of internal code. Mirrors the smoke test's in-process handler stub
 * pattern, but composes through `mountFaremeterTestRoute` rather than
 * calling `faremeterHono.createMiddleware` inline.
 */

import { describe, test, expect } from "bun:test";
import { Hono } from "hono";
import type { Env } from "../src/types.js";
import {
  isFaremeterEnabled,
  mountFaremeterTestRoute,
  stubFaremeterHandlers,
  stubFaremeterPricing,
} from "../src/routes/faremeter-test.js";

function buildApp(flagValue: string | undefined): {
  app: Hono<{ Bindings: Env }>;
  env: Partial<Env>;
} {
  const env: Partial<Env> = { FAREMETER_ENABLED: flagValue };
  const app = new Hono<{ Bindings: Env }>();
  mountFaremeterTestRoute(app, {
    handlers: stubFaremeterHandlers,
    pricing: stubFaremeterPricing,
  });
  return { app, env };
}

describe("isFaremeterEnabled flag parser", () => {
  test("recognises canonical truthy values", () => {
    expect(isFaremeterEnabled({ FAREMETER_ENABLED: "1" })).toBe(true);
    expect(isFaremeterEnabled({ FAREMETER_ENABLED: "true" })).toBe(true);
    expect(isFaremeterEnabled({ FAREMETER_ENABLED: "TRUE" })).toBe(true);
    expect(isFaremeterEnabled({ FAREMETER_ENABLED: " true " })).toBe(true);
  });

  test("rejects every other variant including ambiguous truthy synonyms", () => {
    expect(isFaremeterEnabled({})).toBe(false);
    expect(isFaremeterEnabled({ FAREMETER_ENABLED: "" })).toBe(false);
    expect(isFaremeterEnabled({ FAREMETER_ENABLED: "0" })).toBe(false);
    expect(isFaremeterEnabled({ FAREMETER_ENABLED: "false" })).toBe(false);
    expect(isFaremeterEnabled({ FAREMETER_ENABLED: "yes" })).toBe(false);
    expect(isFaremeterEnabled({ FAREMETER_ENABLED: "on" })).toBe(false);
    expect(isFaremeterEnabled({ FAREMETER_ENABLED: "enabled" })).toBe(false);
  });
});

describe("/v1/test/paid round-trip", () => {
  test("flag OFF (unset) returns 503 faremeter_disabled", async () => {
    const { app, env } = buildApp(undefined);
    const res = await app.request("/v1/test/paid", { method: "GET" }, env);
    expect(res.status).toBe(503);
    const body = (await res.json()) as { error?: string; code?: string };
    expect(body.error).toBe("faremeter_disabled");
    expect(body.code).toBe("FAREMETER_FLAG_OFF");
  });

  test("flag OFF (\"0\") returns 503 faremeter_disabled", async () => {
    const { app, env } = buildApp("0");
    const res = await app.request("/v1/test/paid", { method: "GET" }, env);
    expect(res.status).toBe(503);
  });

  test("flag ON (\"1\") with no X-PAYMENT returns 402 with accepts[]", async () => {
    const { app, env } = buildApp("1");
    const res = await app.request("/v1/test/paid", { method: "GET" }, env);
    expect(res.status).toBe(402);
    const body = (await res.json()) as {
      accepts?: unknown;
      x402Version?: number;
    };
    expect(Array.isArray(body.accepts)).toBe(true);
    expect((body.accepts as unknown[]).length).toBeGreaterThan(0);
    // Spot-check the first accept has the devnet shape the stub pricing emits.
    const first = (body.accepts as Array<Record<string, unknown>>)[0];
    expect(first.network).toBe("solana-devnet");
    expect(first.scheme).toBe("exact");
    expect(first.asset).toBe("USDC");
  });

  test("flag ON (\"true\") still emits 402 (case-insensitive)", async () => {
    const { app, env } = buildApp("true");
    const res = await app.request("/v1/test/paid", { method: "GET" }, env);
    expect(res.status).toBe(402);
  });

  test("flag ON + invalid X-PAYMENT does NOT pass through (stub handleVerify=null)", async () => {
    const { app, env } = buildApp("1");
    const res = await app.request(
      "/v1/test/paid",
      {
        method: "GET",
        headers: { "X-PAYMENT": "not-a-real-x402-envelope" },
      },
      env,
    );
    // The stub returns null from handleVerify, so middleware MUST NOT
    // hand the request to the GET handler. We don't pin the exact status
    // (402 vs 400 vs 500) because that is faremeter's choice, only that
    // the GET handler's ok:true body is NOT what came back.
    const body = (await res.text());
    expect(body).not.toContain("\"ok\":true");
    expect(body).not.toContain("faremeter_test_paid");
  });
});
