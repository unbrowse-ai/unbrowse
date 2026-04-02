import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { searchRoutes } from "../src/routes/search.js";
import type { Env } from "../src/types.js";

const BASE_ENV: Env = {
  API_KEY: "test-api-key",
  UNKEY_ROOT_KEY: "test-unkey-root",
  UNKEY_API_ID: "test-unkey-api",
  EMERGENTDB_API_KEY: "test-emergent",
  NEBIUS_API_KEY: "test-nebius",
  STATS_KV: {} as KVNamespace,
  ENVIRONMENT: "production",
  PAYMENT_RECIPIENT: "0xfeedfacefeedfacefeedfacefeedfacefeedface",
};

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

describe("search route x402 gating", () => {
  const originalFetch = globalThis.fetch;

  beforeEach(() => {
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;

      if (url === "https://facilitator.corbits.dev/supported") {
        return jsonResponse({
          kinds: [
            {
              x402Version: 2,
              scheme: "exact",
              network: "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp",
              extra: {
                feePayer: "fee-payer-solana",
                features: { xSettlementAccountSupported: true },
              },
            },
            {
              x402Version: 2,
              scheme: "exact",
              network: "eip155:8453",
              extra: {
                features: { xSettlementAccountSupported: true },
              },
            },
          ],
          extensions: [],
          signers: {},
        });
      }

      throw new Error(`unexpected fetch: ${url}`);
    }) as typeof globalThis.fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it("returns PAYMENT-REQUIRED when payments are enabled", async () => {
    const res = await searchRoutes.request("http://localhost/search", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ intent: "search packages", k: 5 }),
    }, BASE_ENV);

    const body = await res.json() as Record<string, unknown>;
    const header = res.headers.get("PAYMENT-REQUIRED");
    const terms = header
      ? JSON.parse(Buffer.from(header, "base64").toString("utf8")) as {
          x402Version: number;
          accepts: Array<Record<string, unknown>>;
        }
      : null;

    expect(res.status).toBe(402);
    expect(body.error).toBe("Payment Required");
    expect(terms?.x402Version).toBe(2);
    expect(terms?.accepts).toHaveLength(2);
    expect(terms?.accepts.every((entry) => entry.amount === "1000" || entry.amount === 1000)).toBe(true);
    expect(terms?.accepts.every((entry) => entry.payTo === BASE_ENV.PAYMENT_RECIPIENT)).toBe(true);
  });

  it("allows staging search to advertise mainnet terms when X402_NETWORK_MODE=mainnet", async () => {
    const res = await searchRoutes.request("http://localhost/search", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ intent: "search packages", k: 5 }),
    }, { ...BASE_ENV, ENVIRONMENT: "staging", X402_NETWORK_MODE: "mainnet" });

    const header = res.headers.get("PAYMENT-REQUIRED");
    const terms = header
      ? JSON.parse(Buffer.from(header, "base64").toString("utf8")) as {
          accepts: Array<Record<string, unknown>>;
        }
      : null;

    expect(res.status).toBe(402);
    expect(terms?.accepts.map((entry) => entry.network).sort()).toEqual([
      "eip155:8453",
      "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp",
    ]);
  });

  it("keeps staging search free when payments are disabled", async () => {
    const res = await searchRoutes.request("http://localhost/search", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ intent: "search packages", k: 5 }),
    }, { ...BASE_ENV, ENVIRONMENT: "staging", PAYMENTS_ENABLED: "false" });

    const body = await res.json() as Record<string, unknown>;

    expect(res.status).toBe(200);
    expect(body.results).toEqual([]);
    expect(res.headers.get("X-Unbrowse-Cost-Uc")).toBeNull();
  });

  it("disables search payments entirely when PAYMENTS_ENABLED=false", async () => {
    const res = await searchRoutes.request("http://localhost/search", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ intent: "search packages", k: 5 }),
    }, { ...BASE_ENV, PAYMENTS_ENABLED: "false" });

    const body = await res.json() as Record<string, unknown>;

    expect(res.status).toBe(200);
    expect(body.results).toEqual([]);
    expect(res.headers.get("PAYMENT-REQUIRED")).toBeNull();
    expect(res.headers.get("X-Unbrowse-Cost-Uc")).toBeNull();
  });
});
