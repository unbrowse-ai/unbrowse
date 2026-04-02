import { afterEach, describe, expect, it } from "bun:test";
import { isX402Error, searchIntentResolve } from "../src/client/index.js";

const originalFetch = globalThis.fetch;

function encodeBase64Json(value: unknown): string {
  return Buffer.from(JSON.stringify(value), "utf8").toString("base64");
}

afterEach(() => {
  globalThis.fetch = originalFetch;
});

describe("client search x402 propagation", () => {
  it("rethrows payment-required errors from search resolve instead of swallowing them", async () => {
    globalThis.fetch = (async () =>
      new Response(JSON.stringify({ error: "Payment Required" }), {
        status: 402,
        headers: {
          "content-type": "application/json",
          "PAYMENT-REQUIRED": encodeBase64Json({
            x402Version: 2,
            resource: { url: "https://beta-api.unbrowse.ai/v1/search/resolve" },
            accepts: [],
          }),
        },
      })) as typeof globalThis.fetch;

    let caught: unknown;
    try {
      await searchIntentResolve("search packages", "npmjs.com", 5, 10);
    } catch (err) {
      caught = err;
    }

    expect(isX402Error(caught)).toBe(true);
    expect((caught as { status?: number }).status).toBe(402);
  });
});
