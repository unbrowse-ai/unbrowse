import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { isX402Error, searchIntentResolve } from "../src/client/index.js";

const originalFetch = globalThis.fetch;
const originalHome = process.env.HOME;

function encodeBase64Json(value: unknown): string {
  return Buffer.from(JSON.stringify(value), "utf8").toString("base64");
}

// Hermetic isolation: a real ~/.lobster wallet makes apiRequest's 402 handler
// attempt a live lobster pay-and-retry (subprocess hits the network) instead of
// surfacing the x402 error this test asserts. Empty HOME → isLobsterAvailable()
// === false, so the handler falls through to `throw x402Error` deterministically.
beforeEach(() => {
  process.env.HOME = mkdtempSync(join(tmpdir(), "unbrowse-clientsearch-home-"));
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  process.env.HOME = originalHome;
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

  it("returns actual_cost_uc when the backend reports billed search cost", async () => {
    globalThis.fetch = (async () =>
      new Response(JSON.stringify({
        domain_results: [],
        global_results: [],
        skipped_global: false,
      }), {
        status: 200,
        headers: {
          "content-type": "application/json",
          "X-Unbrowse-Cost-Uc": "1000",
        },
      })) as typeof globalThis.fetch;

    const result = await searchIntentResolve("search packages", "npmjs.com", 5, 10);
    expect(result.actual_cost_uc).toBe(1000);
  });
});
