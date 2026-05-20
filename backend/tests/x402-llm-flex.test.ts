/**
 * x402-llm-flex.test.ts - integration test for /v1/llm/:provider/messages
 * after the Faremeter Flex pivot.
 *
 * Asserts the post-pivot contract:
 *   1. POST without X-PAYMENT -> 402 with accepts[] using the Solana scheme
 *      (network `solana:...`, USDC asset), facilitator tagged
 *      "faremeter-flex-solana", and the operator-markup extras populated.
 *   2. POST with an unknown model -> 404.
 *   3. POST with a missing model -> 400.
 *   4. POST with a malformed X-PAYMENT header -> 402 via handleFlexPaymentAuthorized.
 *
 * The "valid X-PAYMENT -> 200" path is covered by tests/flex-end-to-end.test.ts
 * which exercises the Flex facilitator wire shape directly.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";

// Mock xgate.run upstream BEFORE importing the route. Only /v1/models is hit
// in this test (the 402 branch doesn't reach the proxy; malformed X-PAYMENT
// also short-circuits before proxy).
const originalFetch = globalThis.fetch;

beforeAll(() => {
  globalThis.fetch = (async (input: string | URL | Request) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    if (url.endsWith("/v1/models")) {
      return new Response(
        JSON.stringify({
          data: [
            {
              id: "claude-sonnet-4-6",
              display_name: "Claude Sonnet 4.6",
              provider: "anthropic",
              pricing: { input_per_1m: "3", output_per_1m: "15" },
            },
          ],
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }
    return new Response("not mocked", { status: 500 });
  }) as typeof fetch;
});

afterAll(() => {
  globalThis.fetch = originalFetch;
});

import { llmRoutes } from "../src/routes/llm.js";
import { Hono } from "hono";

const TEST_ENV: Record<string, string> = {
  // Solana mainnet platform wallet (matches the live unbrowse env shape).
  PAYMENT_RECIPIENT: "6KpxaoPoTDBAMxNNMPQvQEnTbErtjogL2unK8q3VKcdn",
};

const app = new Hono();
app.route("/v1/llm", llmRoutes);

async function call(path: string, init: RequestInit) {
  return await app.fetch(new Request(`http://test.local${path}`, init), TEST_ENV);
}

describe("POST /v1/llm/:provider/messages (Faremeter Flex on Solana)", () => {
  test("missing X-PAYMENT returns 402 with Solana accepts[]", async () => {
    const res = await call("/v1/llm/anthropic/messages", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "claude-sonnet-4-6", messages: [{ role: "user", content: "hi" }] }),
    });
    expect(res.status).toBe(402);
    const body = (await res.json()) as {
      x402Version: number;
      error: string;
      accepts: Array<Record<string, unknown>>;
      facilitator: string;
      extra: Record<string, unknown>;
    };
    expect(body.x402Version).toBe(2);
    expect(body.error).toBe("payment_required");
    expect(body.facilitator).toBe("faremeter-flex-solana");
    expect(Array.isArray(body.accepts)).toBe(true);
    expect(body.accepts.length).toBeGreaterThanOrEqual(1);

    const a = body.accepts[0];
    expect(a.scheme).toBe("exact");
    expect(String(a.network)).toMatch(/^solana:/);
    expect(a.asset).toBeTruthy();
    expect(a.payTo).toBe(TEST_ENV.PAYMENT_RECIPIENT);

    const extra = body.extra;
    expect(extra.markup).toBe(1.5);
    expect(Number(extra.passthrough_usd)).toBeGreaterThan(0);
    expect(extra.provider).toBe("anthropic");
    expect(extra.model).toBe("claude-sonnet-4-6");

    // base64 PAYMENT-REQUIRED header for generic-client compatibility
    const enc = res.headers.get("payment-required");
    expect(typeof enc).toBe("string");
    expect((enc ?? "").length).toBeGreaterThan(0);
  });

  test("unknown model returns 404", async () => {
    const res = await call("/v1/llm/anthropic/messages", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "fake-model-xyz", messages: [] }),
    });
    expect(res.status).toBe(404);
  });

  test("missing model returns 400", async () => {
    const res = await call("/v1/llm/anthropic/messages", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ messages: [] }),
    });
    expect(res.status).toBe(400);
  });

  test("malformed X-PAYMENT header returns 402 via handleFlexPaymentAuthorized", async () => {
    const res = await call("/v1/llm/anthropic/messages", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "X-PAYMENT": "not-base64-not-json",
      },
      body: JSON.stringify({ model: "claude-sonnet-4-6", messages: [] }),
    });
    expect(res.status).toBe(402);
    const body = (await res.json()) as { error?: string; reason?: string };
    expect(body.error).toBe("flex_verify_failed");
    expect(body.reason).toBe("malformed_payload");
  });
});
