import { afterEach, describe, expect, it } from "bun:test";
import type { SkillManifest } from "../src/types/index.js";
import { ensureCascadeSplitForSkill } from "../src/payments/cascade.js";

const ORIGINAL_ENV = { ...process.env };
const ORIGINAL_FETCH = globalThis.fetch;

async function loadClientModule() {
  return import(`../src/client/index.ts?cascade=${Date.now()}-${Math.random()}`);
}

afterEach(() => {
  for (const key of Object.keys(process.env)) {
    if (!(key in ORIGINAL_ENV)) delete process.env[key];
  }
  for (const [key, value] of Object.entries(ORIGINAL_ENV)) {
    process.env[key] = value;
  }
  globalThis.fetch = ORIGINAL_FETCH;
});

const splitSkill: Pick<SkillManifest, "skill_id" | "contributors" | "split_config"> = {
  skill_id: "skill-cascade",
  contributors: [
    {
      agent_id: "agent-a",
      wallet_address: "Agent111111111111111111111111111111111111111",
      endpoints_contributed: 2,
      cumulative_delta: 3,
      share: 68,
      first_contributed_at: "2026-04-02T00:00:00.000Z",
      last_contributed_at: "2026-04-02T00:00:00.000Z",
    },
    {
      agent_id: "agent-b",
      wallet_address: "Agent222222222222222222222222222222222222222",
      endpoints_contributed: 1,
      cumulative_delta: 1,
      share: 22,
      first_contributed_at: "2026-04-02T00:00:00.000Z",
      last_contributed_at: "2026-04-02T00:00:00.000Z",
    },
  ],
};

describe("Cascade split provisioning", () => {
  it("uses explicit split address override when configured", async () => {
    const result = await ensureCascadeSplitForSkill(splitSkill, {
      env: {
        ...process.env,
        UNBROWSE_CASCADE_SPLIT_ADDRESS: "7xKpQ9Lm2Rn3Wp4Ys5Zt6Au7Bv8Cw9Dx1Ey2Fz3mNq",
      },
    });

    expect(result).toEqual({
      split_config: "7xKpQ9Lm2Rn3Wp4Ys5Zt6Au7Bv8Cw9Dx1Ey2Fz3mNq",
      source: "env",
    });
  });

  it("builds Cascade recipients and returns splitConfig from the SDK", async () => {
    const calls: Array<{ recipients: Array<{ address: string; share: number }>; uniqueId: unknown }> = [];
    const result = await ensureCascadeSplitForSkill(splitSkill, {
      env: {
        ...process.env,
        UNBROWSE_CASCADE_PLATFORM_WALLET: "Marketplace1111111111111111111111111111111111",
        UNBROWSE_CASCADE_SIGNER_SECRET_KEY: JSON.stringify(Array.from({ length: 64 }, (_, i) => i + 1)),
        UNBROWSE_CASCADE_RPC_URL: "https://rpc.example.com",
        UNBROWSE_CASCADE_RPC_WS_URL: "wss://rpc.example.com",
      },
      loadKit: async () => ({
        createSolanaRpc: (url: string) => ({ url }),
        createSolanaRpcSubscriptions: (url: string) => ({ url }),
        createKeyPairSignerFromBytes: async (secretKey: Uint8Array) => ({ secretKey }),
      }),
      loadSdk: async () => ({
        labelToSeed: (label: string) => label,
        createSplitsClient: () => ({
          ensureSplit: async ({ recipients, uniqueId }) => {
            calls.push({ recipients, uniqueId });
            return {
              status: "created",
              splitConfig: "7xKpQ9Lm2Rn3Wp4Ys5Zt6Au7Bv8Cw9Dx1Ey2Fz3mNq",
            };
          },
        }),
      }),
    });

    expect(calls).toHaveLength(1);
    expect(calls[0]?.recipients).toEqual([
      { address: "Marketplace1111111111111111111111111111111111", share: 10 },
      { address: "Agent111111111111111111111111111111111111111", share: 68 },
      { address: "Agent222222222222222222222222222222222222222", share: 22 },
    ]);
    expect(String(calls[0]?.uniqueId)).toContain("ubr-");
    expect(result).toEqual({
      split_config: "7xKpQ9Lm2Rn3Wp4Ys5Zt6Au7Bv8Cw9Dx1Ey2Fz3mNq",
      source: "sdk",
    });
  });

  it("patches split_config after publish when an explicit split address is configured", async () => {
    process.env.UNBROWSE_API_KEY = "test-key";
    process.env.UNBROWSE_CASCADE_SPLIT_ADDRESS = "7xKpQ9Lm2Rn3Wp4Ys5Zt6Au7Bv8Cw9Dx1Ey2Fz3mNq";
    process.env.LOBSTER_WALLET_ADDRESS = "wallet-live";

    const calls: Array<{ url: string; method: string; body?: Record<string, unknown> }> = [];
    globalThis.fetch = async (input, init) => {
      const url = input instanceof Request ? input.url : String(input);
      const method = init?.method ?? "GET";
      const body = init?.body ? JSON.parse(String(init.body)) as Record<string, unknown> : undefined;
      calls.push({ url, method, body });

      if (url.endsWith("/v1/skills") && method === "POST") {
        return new Response(JSON.stringify({
          skill_id: "skill-cascade",
          version: "1.0.0",
          schema_version: "1",
          name: "example.com",
          intent_signature: "example.com",
          domain: "example.com",
          description: "fixture",
          owner_type: "marketplace",
          execution_type: "http",
          endpoints: [{ endpoint_id: "ep-1" }],
          lifecycle: "active",
          contributors: splitSkill.contributors,
          created_at: "2026-04-02T00:00:00.000Z",
          updated_at: "2026-04-02T00:00:00.000Z",
          warnings: [],
        }), { status: 201, headers: { "Content-Type": "application/json" } });
      }

      if (url.endsWith("/v1/skills/skill-cascade") && method === "PATCH") {
        return new Response(JSON.stringify({
          skill_id: "skill-cascade",
          version: "1.0.0",
          schema_version: "1",
          name: "example.com",
          intent_signature: "example.com",
          domain: "example.com",
          description: "fixture",
          owner_type: "marketplace",
          execution_type: "http",
          endpoints: [{ endpoint_id: "ep-1" }],
          lifecycle: "active",
          contributors: splitSkill.contributors,
          split_config: body?.split_config,
          created_at: "2026-04-02T00:00:00.000Z",
          updated_at: "2026-04-02T00:00:00.000Z",
        }), { status: 200, headers: { "Content-Type": "application/json" } });
      }

      throw new Error(`unexpected fetch: ${method} ${url}`);
    };

    const { publishSkill } = await loadClientModule();
    const published = await publishSkill({
      domain: "example.com",
      intent_signature: "example.com",
      description: "fixture",
      owner_type: "marketplace",
      execution_type: "http",
      endpoints: [{ endpoint_id: "ep-1" }] as any,
      lifecycle: "active",
    } as any);

    expect(published.split_config).toBe("7xKpQ9Lm2Rn3Wp4Ys5Zt6Au7Bv8Cw9Dx1Ey2Fz3mNq");
    const postCall = calls.find((call) => call.method === "POST");
    expect(postCall?.body).toEqual(expect.objectContaining({
      wallet_address: "wallet-live",
      wallet_provider: "lobster.cash",
    }));
    const patchCall = calls.find((call) => call.method === "PATCH");
    expect(patchCall?.body).toEqual({
      split_config: "7xKpQ9Lm2Rn3Wp4Ys5Zt6Au7Bv8Cw9Dx1Ey2Fz3mNq",
    });
  });
});
