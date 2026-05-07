import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { publicSkillRoutes } from "../src/routes/skills.js";
import { clearSupportedKindsCacheForTests, x402UseTestnet } from "../src/middleware/x402-gate.js";
import type { Env, SkillManifest } from "../src/types.js";

const PAID_SKILL_ID = "skill-paid-x402";
const BASE_ENV: Env = {
  API_KEY: "test-api-key",
  EMERGENTDB_API_KEY: "test-emergent",
  NEBIUS_API_KEY: "test-nebius",
  STATS_KV: {} as KVNamespace,
  ENVIRONMENT: "staging",
  PAYMENT_RECIPIENT: "0xfeedfacefeedfacefeedfacefeedfacefeedface",
};

const paidSkill: SkillManifest = {
  skill_id: PAID_SKILL_ID,
  version: "1.0.0",
  schema_version: "1",
  name: "Example Skill",
  intent_signature: "example.com",
  domain: "example.com",
  description: "Paid skill fixture",
  owner_type: "marketplace",
  execution_type: "http",
  endpoints: [
    {
      endpoint_id: "ep-1",
      method: "GET",
      url_template: "https://example.com/api/search",
      description: "Search endpoint",
      idempotency: "safe",
      verification_status: "verified",
      reliability_score: 0.9,
    },
  ],
  lifecycle: "active",
  base_price_usd: 0.002,
  contributors: [
    {
      agent_id: "agent-alpha",
      wallet_address: "So1anaContributor1111111111111111111111111111",
      endpoints_contributed: 1,
      cumulative_delta: 1,
      share: 90,
      first_contributed_at: "2026-04-02T00:00:00.000Z",
      last_contributed_at: "2026-04-02T00:00:00.000Z",
    },
  ],
  created_at: "2026-04-02T00:00:00.000Z",
  updated_at: "2026-04-02T00:00:00.000Z",
};

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function encodeBase64Json(value: unknown): string {
  return Buffer.from(JSON.stringify(value), "utf8").toString("base64");
}

describe("public skill x402 route", () => {
  const originalFetch = globalThis.fetch;

  beforeEach(() => {
    clearSupportedKindsCacheForTests();
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;

      if (url.includes("/qdkv/get/")) {
        const key = decodeURIComponent(url.split("/qdkv/get/")[1] ?? "");
        if (key.endsWith(`:skill:${PAID_SKILL_ID}`)) {
          return jsonResponse({ found: true, value: JSON.stringify(paidSkill) });
        }
        if (key.includes("stats:stats:")) {
          return jsonResponse({ found: false, value: null });
        }
        return jsonResponse({ found: false, value: null });
      }

      if (url === "https://facilitator.corbits.dev/settle") {
        const body = init?.body ? JSON.parse(String(init.body)) : {};
        if (body.x402Version === 2 && body.paymentPayload?.payload?.proof === "proof-ok") {
          return jsonResponse({ success: true, transaction: "tx-123", networkId: body.paymentPayload.network });
        }
        return jsonResponse({ success: false }, 402);
      }

      if (url === "https://facilitator.corbits.dev/verify") {
        const body = init?.body ? JSON.parse(String(init.body)) : {};
        if (
          body.x402Version === 2
          && body.paymentPayload?.payload?.proof === "proof-ok"
          && typeof body.paymentPayload?.network === "string"
          && typeof body.paymentPayload?.scheme === "string"
        ) {
          const reqs = body.paymentRequirements ?? {};
          if (typeof reqs.maxAmountRequired === "string" && typeof reqs.resource === "string" && typeof reqs.description === "string") {
            return jsonResponse({ isValid: true, invalidReason: null });
          }
        }
        return jsonResponse({ isValid: false, invalidReason: "bad-proof" }, 402);
      }

      if (url === "https://facilitator.corbits.dev/supported") {
        return jsonResponse({
          kinds: [
            {
              x402Version: 2,
              scheme: "exact",
              network: "solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1",
              extra: {
                feePayer: "fee-payer-solana",
                features: { xSettlementAccountSupported: true },
              },
            },
            {
              x402Version: 2,
              scheme: "exact",
              network: "eip155:84532",
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

  it("returns lobster-compatible PAYMENT-REQUIRED terms when proof is missing", async () => {
    const res = await publicSkillRoutes.request(`http://localhost/skills/${PAID_SKILL_ID}`, {}, BASE_ENV);
    const body = await res.json() as Record<string, unknown>;
    const header = res.headers.get("PAYMENT-REQUIRED");
    const terms = header ? JSON.parse(Buffer.from(header, "base64").toString("utf8")) as {
      x402Version: number;
      accepts: Array<Record<string, unknown>>;
    } : null;

    expect(res.status).toBe(402);
    expect(body.error).toBe("Payment Required");
    expect(terms?.x402Version).toBe(2);
    expect(Array.isArray(terms?.accepts)).toBe(true);
    expect(terms?.accepts).toHaveLength(2);
    expect(terms?.accepts.map((entry) => entry.network).sort()).toEqual(["eip155:84532", "solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1"]);
    expect(terms?.accepts.every((entry) => entry.amount === 1000 || entry.amount === "1000")).toBe(true);
    expect(terms?.accepts.every((entry) => entry.payTo === "So1anaContributor1111111111111111111111111111")).toBe(true);
    expect(terms?.accepts.find((entry) => entry.network === "solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1")?.extra).toEqual({
      feePayer: "fee-payer-solana",
      features: { xSettlementAccountSupported: true },
    });
  });

  it("allows staging to advertise mainnet terms when X402_NETWORK_MODE=mainnet", async () => {
    const res = await publicSkillRoutes.request(
      `http://localhost/skills/${PAID_SKILL_ID}`,
      {},
      { ...BASE_ENV, X402_NETWORK_MODE: "mainnet" },
    );
    const header = res.headers.get("PAYMENT-REQUIRED");
    const terms = header ? JSON.parse(Buffer.from(header, "base64").toString("utf8")) as {
      accepts: Array<Record<string, unknown>>;
    } : null;

    expect(res.status).toBe(402);
    expect(terms?.accepts.map((entry) => entry.network).sort()).toEqual([
      "eip155:8453",
      "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp",
    ]);
  });

  it("returns the skill when a valid PAYMENT-SIGNATURE is supplied", async () => {
    const accepted = {
      scheme: "exact",
      network: "solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1",
      amount: "1000",
      asset: "USDC",
      payTo: "So1anaContributor1111111111111111111111111111",
      maxTimeoutSeconds: 300,
      extra: {
        feePayer: "fee-payer-solana",
        features: { xSettlementAccountSupported: true },
      },
    };

    const res = await publicSkillRoutes.request(
      `http://localhost/skills/${PAID_SKILL_ID}`,
      {
        headers: {
          "PAYMENT-SIGNATURE": encodeBase64Json({
            x402Version: 2,
            accepted,
            resource: {
              url: `http://localhost/skills/${PAID_SKILL_ID}`,
              description: `Skill access: ${PAID_SKILL_ID}`,
              mimeType: "application/json",
            },
            payload: { proof: "proof-ok" },
          }),
        },
      },
      BASE_ENV,
    );
    const body = await res.json() as SkillManifest;

    expect(res.status).toBe(200);
    expect(res.headers.get("PAYMENT-RESPONSE")).toBeTruthy();
    expect(body.skill_id).toBe(PAID_SKILL_ID);
    expect(body.base_price_usd).toBe(0.002);
  });

  it("disables skill payments entirely when PAYMENTS_ENABLED=false", async () => {
    const res = await publicSkillRoutes.request(
      `http://localhost/skills/${PAID_SKILL_ID}`,
      {},
      { ...BASE_ENV, PAYMENTS_ENABLED: "false" },
    );
    const body = await res.json() as SkillManifest;

    expect(res.status).toBe(200);
    expect(res.headers.get("PAYMENT-REQUIRED")).toBeNull();
    expect(body.skill_id).toBe(PAID_SKILL_ID);
  });

  it("keeps paid skill detail gated when free search mode is enabled", async () => {
    const res = await publicSkillRoutes.request(
      `http://localhost/skills/${PAID_SKILL_ID}`,
      {},
      { ...BASE_ENV, X402_SEARCH_ENABLED: "false" },
    );

    expect(res.status).toBe(402);
    expect(res.headers.get("PAYMENT-REQUIRED")).toBeTruthy();
  });

  it("routes multi-contributor skills to the majority contributor wallet", async () => {
    const multiContributorSkill: SkillManifest = {
      ...paidSkill,
      contributors: [
        {
          agent_id: "agent-alpha",
          wallet_address: "So1anaContributor1111111111111111111111111111",
          endpoints_contributed: 3,
          cumulative_delta: 3,
          share: 45,
          first_contributed_at: "2026-04-02T00:00:00.000Z",
          last_contributed_at: "2026-04-02T00:00:00.000Z",
        },
        {
          agent_id: "agent-beta",
          wallet_address: "So1anaContributor2222222222222222222222222222",
          endpoints_contributed: 1,
          cumulative_delta: 1,
          share: 45,
          first_contributed_at: "2026-04-02T00:00:00.000Z",
          last_contributed_at: "2026-04-02T00:00:00.000Z",
        },
      ],
      split_config: "7xKpQ9Lm2Rn3Wp4Ys5Zt6Au7Bv8Cw9Dx1Ey2Fz3mNq",
    };

    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;

      if (url.includes("/qdkv/get/")) {
        const key = decodeURIComponent(url.split("/qdkv/get/")[1] ?? "");
        if (key.endsWith(`:skill:${PAID_SKILL_ID}`)) {
          return jsonResponse({ found: true, value: JSON.stringify(multiContributorSkill) });
        }
        if (key.includes("stats:stats:")) {
          return jsonResponse({ found: false, value: null });
        }
        return jsonResponse({ found: false, value: null });
      }

      if (url === "https://facilitator.corbits.dev/supported") {
        return jsonResponse({
          kinds: [
            {
              x402Version: 2,
              scheme: "exact",
              network: "solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1",
              extra: { feePayer: "fee-payer-solana", features: { xSettlementAccountSupported: true } },
            },
          ],
          extensions: [],
          signers: {},
        });
      }

      throw new Error(`unexpected fetch: ${url}`);
    }) as typeof globalThis.fetch;

    const res = await publicSkillRoutes.request(`http://localhost/skills/${PAID_SKILL_ID}`, {}, BASE_ENV);
    const header = res.headers.get("PAYMENT-REQUIRED");
    const terms = header ? JSON.parse(Buffer.from(header, "base64").toString("utf8")) as {
      accepts: Array<Record<string, unknown>>;
    } : null;

    expect(res.status).toBe(402);
    expect(terms?.accepts[0]?.payTo).toBe("So1anaContributor1111111111111111111111111111");
  });
});

describe("x402UseTestnet", () => {
  it("defaults staging to testnet and production to mainnet", () => {
    expect(x402UseTestnet({ ENVIRONMENT: "staging" })).toBe(true);
    expect(x402UseTestnet({ ENVIRONMENT: "production" })).toBe(false);
  });

  it("allows explicit network override", () => {
    expect(x402UseTestnet({ ENVIRONMENT: "staging", X402_NETWORK_MODE: "mainnet" })).toBe(false);
    expect(x402UseTestnet({ ENVIRONMENT: "production", X402_NETWORK_MODE: "testnet" })).toBe(true);
  });
});
