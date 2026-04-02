import { afterEach, describe, expect, it } from "bun:test";
import { resolveAndExecute } from "../src/orchestrator/index.js";

const originalFetch = globalThis.fetch;

function encodeBase64Json(value: unknown): string {
  return Buffer.from(JSON.stringify(value), "utf8").toString("base64");
}

afterEach(() => {
  globalThis.fetch = originalFetch;
});

describe("orchestrator search x402 propagation", () => {
  it("returns payment_required when marketplace search is x402-gated", async () => {
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
      if (url.includes("/v1/search/resolve")) {
        return new Response(JSON.stringify({ error: "Payment Required" }), {
          status: 402,
          headers: {
            "content-type": "application/json",
            "PAYMENT-REQUIRED": encodeBase64Json({
              x402Version: 2,
              resource: { url },
              accepts: [{ amount: "1000", network: "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp" }],
            }),
          },
        });
      }
      throw new Error(`unexpected fetch: ${url}`);
    }) as typeof globalThis.fetch;

    const out = await resolveAndExecute(
      "search packages",
      {},
      { url: "https://www.npmjs.com/search?q=openai" },
    );

    expect(out.source).toBe("marketplace");
    expect(out.trace.status_code).toBe(402);
    expect((out.result as Record<string, unknown>).error).toBe("payment_required");
    expect((out.result as Record<string, unknown>).tier).toBe("tier3");
  });
});
