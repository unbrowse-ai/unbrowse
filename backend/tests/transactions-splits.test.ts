import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import type { Env, SkillManifest } from "../src/types.js";
import { skillsKV, statsKV } from "../src/services/kv.js";
import { getConsumerTransactions, getCreatorTransactions, recordTransaction } from "../src/services/transactions.js";

const env: Env = {
  API_KEY: "admin",
  UNKEY_ROOT_KEY: "root",
  UNKEY_API_ID: "api",
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

    throw new Error(`Unexpected fetch: ${url.toString()}`);
  };
}

const skill: SkillManifest = {
  skill_id: "skill-split",
  version: "1.0.0",
  schema_version: "1",
  name: "Split Skill",
  intent_signature: "example.com",
  domain: "example.com",
  description: "Split payout fixture",
  owner_type: "marketplace",
  execution_type: "http",
  lifecycle: "active",
  base_price_usd: 0.01,
  endpoints: [],
  contributors: [
    {
      agent_id: "agent-a",
      wallet_address: "wallet-a",
      endpoints_contributed: 4,
      cumulative_delta: 3,
      share: 0,
      first_contributed_at: "2026-04-02T00:00:00.000Z",
      last_contributed_at: "2026-04-02T00:00:00.000Z",
    },
    {
      agent_id: "agent-b",
      wallet_address: "wallet-b",
      endpoints_contributed: 2,
      cumulative_delta: 1,
      share: 0,
      first_contributed_at: "2026-04-02T00:00:00.000Z",
      last_contributed_at: "2026-04-02T00:00:00.000Z",
    },
  ],
  created_at: "2026-04-02T00:00:00.000Z",
  updated_at: "2026-04-02T00:00:00.000Z",
};

describe("transaction contributor payout routing", () => {
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

  it("routes creator earnings to the majority contributor from the skill manifest", async () => {
    const tx = await recordTransaction(env, {
      transaction_id: "tx-split-1",
      consumer_id: "agent-buyer",
      skill_id: skill.skill_id,
      endpoint_id: "search",
      price_usd: 0.01,
    });

    expect(tx.creator_payout_uc).toBe(8000);
    expect(tx.creator_payouts).toEqual([{
      agent_id: "agent-a",
      wallet_address: "wallet-a",
      share: 90,
      payout_uc: 8000,
    }]);

    const buyer = await getConsumerTransactions(env, "agent-buyer");
    expect(buyer.ledger?.total_spent_uc).toBe(10000);
    expect(buyer.transactions).toHaveLength(1);

    const creatorA = await getCreatorTransactions(env, "agent-a");
    const creatorB = await getCreatorTransactions(env, "agent-b");
    expect(creatorA.ledger?.total_earned_uc).toBe(8000);
    expect(creatorB.ledger).toBeNull();
    expect(creatorA.transactions[0]?.creator_id).toBe("agent-a");
    expect(creatorA.transactions[0]?.creator_payout_uc).toBe(8000);
    expect(creatorB.transactions).toEqual([]);
  });
});
