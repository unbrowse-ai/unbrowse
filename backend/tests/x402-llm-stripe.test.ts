/**
 * x402-llm-stripe.test.ts - integration test for the /v1/llm/* x402 route.
 *
 * Asserts the universal x402 entry-point contract:
 *   1. POST /v1/llm/anthropic/messages with no X-PAYMENT -> 402
 *      with accepts[] declaring scheme/network/amount/payTo/extra
 *   2. The 402 body carries OPERATOR_MARKUP=1.5 and a non-zero amount
 *      computed from xgate.run live pricing (mocked here)
 *   3. A legacy PAYMENT-SIGNATURE alone does not authorize the new Flex lane.
 *
 * No real Stripe key, no real xgate fetch. The xgate fetch is replaced via a
 * global mock; PAYTO_ADDRESS is used as the operator wallet for the 402 envelope.
 */

import { afterAll, beforeAll, describe, expect, test, mock } from "bun:test";

// Mock xgate.run upstream BEFORE importing the route. Two endpoints get hit:
//   GET /v1/models  -> pricing for cost estimation
//   POST /v1/chat/completions -> the actual LLM proxy
const originalFetch = globalThis.fetch;
const xgateInvocations: Array<{ url: string; init?: RequestInit }> = [];

beforeAll(() => {
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    xgateInvocations.push({ url, init });
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
    if (url.endsWith("/v1/chat/completions")) {
      return new Response(
        JSON.stringify({
          id: "chatcmpl-test",
          object: "chat.completion",
          model: "claude-sonnet-4-6",
          choices: [{ index: 0, message: { role: "assistant", content: "hello" }, finish_reason: "stop" }],
          usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
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
  PAYTO_ADDRESS: "0xTestBaseDepositAddress",
};

const app = new Hono();
app.route("/v1/llm", llmRoutes);

async function call(path: string, init: RequestInit) {
  return await app.fetch(new Request(`http://test.local${path}`, init), TEST_ENV);
}

describe("POST /v1/llm/:provider/messages (Flex x402)", () => {
  test("missing payment header returns 402 with accepts[]", async () => {
    const res = await call("/v1/llm/anthropic/messages", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "claude-sonnet-4-6", messages: [{ role: "user", content: "hi" }] }),
    });
    expect(res.status).toBe(402);
    const body = (await res.json()) as { x402Version: number; accepts: Array<Record<string, unknown>> };
    expect(body.x402Version).toBe(2);
    expect(Array.isArray(body.accepts)).toBe(true);
    expect(body.accepts.length).toBeGreaterThanOrEqual(1);
    const a = body.accepts[0];
    expect(a.scheme).toBe("exact");
    expect(a.network).toBe("solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp");
    expect(a.payTo).toBe("0xTestBaseDepositAddress");
    const extra = body as unknown as { extra: { markup: number; passthrough_usd: string } };
    expect(extra.extra.markup).toBe(1.5);
    expect(Number(extra.extra.passthrough_usd)).toBeGreaterThan(0);
    // payment-required encoded header should also be present
    const enc = res.headers.get("payment-required");
    expect(typeof enc).toBe("string");
    expect((enc ?? "").length).toBeGreaterThan(0);
  });

  test("legacy PAYMENT-SIGNATURE alone is ignored by the Flex route", async () => {
    const res = await call("/v1/llm/anthropic/messages", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "PAYMENT-SIGNATURE": "test-signature-bytes-base64",
      },
      body: JSON.stringify({ model: "claude-sonnet-4-6", messages: [{ role: "user", content: "hi" }], max_tokens: 100 }),
    });
    expect(res.status).toBe(402);
    const body = (await res.json()) as { error: string; accepts: unknown[] };
    expect(body.error).toBe("payment_required");
    expect(Array.isArray(body.accepts)).toBe(true);
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
});
