import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import type { Env, SkillManifest } from "../src/types.js";
import { skillsKV, statsKV } from "../src/services/kv.js";
import { ensureSkillCascadeSplit } from "../src/services/cascade.js";
import { updateContributorDelta } from "../src/services/splits.js";

const env: Env = {
  API_KEY: "admin",
  EMERGENTDB_API_KEY: "test",
  NEBIUS_API_KEY: "nebius",
  STATS_KV: {} as KVNamespace,
  ENVIRONMENT: "staging",
};

function createMockFetch(store: Map<string, string>) {
  return async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url);
    if (url.hostname !== "api.emergentdb.com") {
      throw new Error(`Unexpected fetch: ${url.toString()}`);
    }

    if (url.pathname === "/qdkv/set") {
      const body = JSON.parse(String(init?.body ?? "{}")) as { key: string; value: string };
      store.set(body.key, body.value);
      return Response.json({ ok: true });
    }

    if (url.pathname.startsWith("/qdkv/get/")) {
      const key = decodeURIComponent(url.pathname.replace("/qdkv/get/", ""));
      const value = store.get(key);
      return Response.json(value == null ? { found: false, value: null } : { found: true, value });
    }

    if (url.pathname.startsWith("/qdkv/del/")) {
      const key = decodeURIComponent(url.pathname.replace("/qdkv/del/", ""));
      store.delete(key);
      return Response.json({ ok: true });
    }

    // Batch get: POST {keys:[...]} -> {values:{key->value|null}}. kv.ts._mget
    // collapses N single-gets into one mget; the mock must mirror it or the
    // listWithValues/index-load paths throw "Unexpected fetch".
    if (url.pathname === "/qdkv/mget") {
      const body = JSON.parse(String(init?.body ?? "{}")) as { keys?: string[] };
      const values: Record<string, string | null> = {};
      for (const key of body.keys ?? []) values[key] = store.get(key) ?? null;
      return Response.json({ values });
    }

    throw new Error(`Unexpected fetch: ${url.toString()}`);
  };
}

const skill: SkillManifest = {
  skill_id: "skill-cascade-backend",
  version: "1.0.0",
  schema_version: "1",
  name: "Cascade Skill",
  intent_signature: "example.com",
  domain: "example.com",
  description: "cascade fixture",
  owner_type: "marketplace",
  execution_type: "http",
  lifecycle: "active",
  base_price_usd: 0.01,
  endpoints: [],
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
  created_at: "2026-04-02T00:00:00.000Z",
  updated_at: "2026-04-02T00:00:00.000Z",
};

describe("backend cascade split sync", () => {
  const store = new Map<string, string>();
  const originalFetch = globalThis.fetch;

  beforeEach(async () => {
    globalThis.fetch = createMockFetch(store) as typeof fetch;
    store.clear();
    await statsKV(env).resetSplitIndex();
    await skillsKV(env).put(`skill:${skill.skill_id}`, JSON.stringify(skill));
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it("builds a deterministic split config via the SDK for multi-contributor skills", async () => {
    const calls: Array<{ recipients: Array<{ address: string; share: number }>; uniqueId: unknown }> = [];
    const result = await ensureSkillCascadeSplit({
      ...env,
      CASCADE_PLATFORM_WALLET: "Marketplace1111111111111111111111111111111111",
      CASCADE_SIGNER_SECRET_KEY: JSON.stringify(Array.from({ length: 64 }, (_, i) => i + 1)),
      CASCADE_RPC_URL: "https://rpc.example.com",
      CASCADE_RPC_WS_URL: "wss://rpc.example.com",
    }, skill, {
      loadKit: async () => ({
        createSolanaRpc: (url: string) => ({ url }),
        createSolanaRpcSubscriptions: (url: string) => ({ url }),
        createKeyPairSignerFromBytes: async () => ({ signer: true }),
      }),
      loadSdk: async () => ({
        labelToSeed: (label: string) => label,
        createSplitsClient: () => ({
          ensureSplit: async ({ recipients, uniqueId }) => {
            calls.push({ recipients, uniqueId });
            return { status: "created", splitConfig: "7xKpQ9Lm2Rn3Wp4Ys5Zt6Au7Bv8Cw9Dx1Ey2Fz3mNq" };
          },
        }),
      }),
    });

    expect(calls[0]?.recipients).toEqual([
      { address: "Marketplace1111111111111111111111111111111111", share: 10 },
      { address: "Agent111111111111111111111111111111111111111", share: 68 },
      { address: "Agent222222222222222222222222222222222222222", share: 22 },
    ]);
    expect(String(calls[0]?.uniqueId)).toContain("ubr-");
    expect(result.split_config).toBe("7xKpQ9Lm2Rn3Wp4Ys5Zt6Au7Bv8Cw9Dx1Ey2Fz3mNq");
  });

  it("updates contributor deltas against the stored skill manifest in skills KV", async () => {
    await updateContributorDelta(env, skill.skill_id, "agent-a", 0.5);

    const updated = await skillsKV(env).get(`skill:${skill.skill_id}`, "json") as SkillManifest | null;
    expect(updated?.contributors?.find((c) => c.agent_id === "agent-a")?.cumulative_delta).toBeGreaterThan(3);
    expect(updated?.contributors?.find((c) => c.agent_id === "agent-a")?.share).toBeGreaterThan(
      updated?.contributors?.find((c) => c.agent_id === "agent-b")?.share ?? 0,
    );
  });
});
