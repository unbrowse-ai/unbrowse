import { afterEach, describe, expect, it } from "bun:test";
import { executeSkill } from "../src/execution/index.js";
import type { EndpointDescriptor, SkillManifest } from "../src/types/index.js";

const originalFetch = globalThis.fetch;
const originalEnv = { ...process.env };

function makePaidSkill(): SkillManifest {
  const endpoint: EndpointDescriptor = {
    endpoint_id: "search",
    method: "GET",
    url_template: "https://example.com/api/search",
    idempotency: "safe",
    verification_status: "verified",
    reliability_score: 1,
    description: "paid search",
  };

  return {
    skill_id: "marketplace:paid-skill",
    version: "1.0.0",
    schema_version: "1",
    lifecycle: "active",
    execution_type: "http",
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
    name: "paid-skill",
    intent_signature: "search things",
    domain: "example.com",
    description: "paid skill",
    owner_type: "community",
    endpoints: [endpoint],
  };
}

afterEach(() => {
  globalThis.fetch = originalFetch;
  process.env = { ...originalEnv };
});

describe("execution payment surface", () => {
  it("returns the configured wallet provider and address in payment-required payloads", async () => {
    process.env.AGENT_WALLET_ADDRESS = "0xfeedface";
    process.env.AGENT_WALLET_PROVIDER = "custom-wallet";

    globalThis.fetch = (async (input: RequestInfo | URL) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
      if (url.includes("/v1/skills/marketplace%3Apaid-skill/price")) {
        return new Response(JSON.stringify({ price_usd: "0.001" }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      throw new Error(`unexpected fetch: ${url}`);
    }) as typeof globalThis.fetch;

    const out = await executeSkill(makePaidSkill(), {}, { raw: true });
    const result = out.result as Record<string, unknown>;

    expect(out.trace.status_code).toBe(402);
    expect(result.error).toBe("payment_required");
    expect(result.wallet_provider).toBe("custom-wallet");
    expect(result.wallet_address).toBe("0xfeedface");
  });
});
