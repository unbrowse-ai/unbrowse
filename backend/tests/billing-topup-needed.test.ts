/**
 * Contract 6110f449 — /v1/billing/topup-needed roadblock surface.
 *
 * Exercises the real Worker route through app.fetch. The route returns a
 * structured ROADBLOCK REQUIRED body only for signals it can honestly know:
 * worker network mode, agent Flex onboarding state, and caller-supplied wallet
 * balance.
 */

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { app } from "../src/index.js";
import type { AgentProfile, Env } from "../src/types.js";
import { clearKVCacheForTests, statsKV } from "../src/services/kv.js";
import { createLocalKey } from "../src/services/keys.js";
import { bindKeyToUser, upsertUser } from "../src/services/accounts.js";
import { CURRENT_TOS_VERSION } from "../src/tos.js";

const baseEnv: Env = {
  API_KEY: "admin",
  EMERGENTDB_API_KEY: "test",
  NEBIUS_API_KEY: "nebius",
  STATS_KV: {} as KVNamespace,
  ENVIRONMENT: "production",
  TURBOBOX_URL: "http://turbobox.local",
  R2_BUCKET: {} as R2Bucket,
  FAL_KEY: "fal",
  RESEND_API_KEY: "re_test",
  RESEND_FROM: "Unbrowse <auth@auth.unbrowse.ai>",
  PUBLIC_API_URL: "http://api.local",
};

let originalFetch: typeof fetch;
let kvStore: Map<string, string>;

function makeFetch(store: Map<string, string>): typeof fetch {
  return (async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const urlStr =
      typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    const url = new URL(urlStr);

    if (url.hostname === "api.emergentdb.com") {
      if (url.pathname === "/qdkv/set") {
        const body = JSON.parse(String(init?.body ?? "{}")) as { key: string; value: string };
        store.set(body.key, body.value);
        return Response.json({ ok: true });
      }
      if (url.pathname.startsWith("/qdkv/get/")) {
        const key = decodeURIComponent(url.pathname.replace("/qdkv/get/", ""));
        const value = store.get(key);
        return Response.json(
          value == null ? { found: false, value: null } : { found: true, value },
        );
      }
      if (url.pathname.startsWith("/qdkv/list/")) {
        const prefix = decodeURIComponent(url.pathname.replace("/qdkv/list/", ""));
        const items = [...store.entries()]
          .filter(([k]) => k.startsWith(prefix))
          .map(([key, value]) => ({ key, value }));
        return Response.json({ items });
      }
      if (url.pathname.startsWith("/qdkv/del/")) {
        const key = decodeURIComponent(url.pathname.replace("/qdkv/del/", ""));
        store.delete(key);
        return Response.json({ ok: true });
      }
      return Response.json({ ok: true });
    }

    if (url.hostname === "api.resend.com") {
      return Response.json({ id: "stub" });
    }

    throw new Error(`Unexpected fetch in test: ${urlStr}`);
  }) as typeof fetch;
}

async function makeBoundKey(env: Env): Promise<{ apiKey: string; agentId: string }> {
  const email = `${crypto.randomUUID()}@test.local`;
  const user = await upsertUser(env, email, { verifyNow: true });
  const created = await createLocalKey(env, "test-key");
  await bindKeyToUser(env, created.keyId, user.user_id);
  return { apiKey: created.key, agentId: created.keyId };
}

async function seedAgent(env: Env, agentId: string, patch: Partial<AgentProfile>): Promise<void> {
  const profile: AgentProfile = {
    agent_id: agentId,
    name: "billing-topup-test-agent",
    created_at: "2026-05-25T00:00:00.000Z",
    skills_discovered: [],
    total_executions: 0,
    total_feedback_given: 0,
    tos_accepted_version: CURRENT_TOS_VERSION,
    tos_accepted_at: "2026-05-25T00:00:00.000Z",
    activity_dates: [],
    ...patch,
  };
  await statsKV(env).put(`agent:${agentId}`, JSON.stringify(profile));
}

async function seedCompleteFlexAgent(env: Env, agentId: string): Promise<void> {
  await seedAgent(env, agentId, {
    wallet_address: "Wallet1111111111111111111111111111111111111",
    flex_escrow_address: "Escrow111111111111111111111111111111111111",
    flex_session_key_address: "Session11111111111111111111111111111111111",
    wallet_provider: "lobster_cash",
  });
}

async function getReq(path: string, headers: Record<string, string> = {}, env: Env = baseEnv) {
  return app.fetch(new Request(`http://local.test${path}`, { headers }), env);
}

async function postJson(
  path: string,
  body: unknown,
  headers: Record<string, string> = {},
  env: Env = baseEnv,
) {
  return app.fetch(
    new Request(`http://local.test${path}`, {
      method: "POST",
      headers: { "content-type": "application/json", ...headers },
      body: JSON.stringify(body),
    }),
    env,
  );
}

beforeEach(() => {
  kvStore = new Map();
  originalFetch = globalThis.fetch;
  globalThis.fetch = makeFetch(kvStore);
  clearKVCacheForTests();
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  clearKVCacheForTests();
});

describe("GET /v1/billing/topup-needed", () => {
  it("rejects unauthenticated callers", async () => {
    const res = await getReq("/v1/billing/topup-needed");
    expect([401, 403]).toContain(res.status);
  });

  it("fires ROADBLOCK REQUIRED when a mainnet endpoint is requested on a testnet worker", async () => {
    const env = { ...baseEnv, X402_NETWORK_MODE: "testnet" };
    const { apiKey, agentId } = await makeBoundKey(env);
    await seedCompleteFlexAgent(env, agentId);
    const res = await getReq(
      "/v1/billing/topup-needed?requested_network=solana-mainnet",
      { authorization: `Bearer ${apiKey}` },
      env,
    );

    expect(res.status).toBe(402);
    expect(res.headers.get("X-Roadblock-Required")).toBe("1");
    expect(res.headers.get("X-Roadblock-Reason")).toBe("mainnet_facilitator_unavailable");
    const body = (await res.json()) as {
      roadblock_required: boolean;
      roadblock: string;
      requirement_block: { kind: string; render_hints: unknown[] };
    };
    expect(body.roadblock_required).toBe(true);
    expect(body.roadblock).toBe("mainnet_facilitator_unavailable");
    expect(body.requirement_block.kind).toBe("ROADBLOCK REQUIRED");
    expect(body.requirement_block.render_hints.length).toBe(3);
  });

  it("fires wallet_balance_low when the caller reports a balance below threshold", async () => {
    const { apiKey, agentId } = await makeBoundKey(baseEnv);
    await seedCompleteFlexAgent(baseEnv, agentId);
    const res = await postJson(
      "/v1/billing/topup-needed",
      { min_balance_uc: 10_000, wallet_balance_uc: 9_999, requested_network: "solana-mainnet" },
      { authorization: `Bearer ${apiKey}` },
    );

    expect(res.status).toBe(402);
    const body = (await res.json()) as {
      roadblock: string;
      amount_usd: number;
      next_step: string;
    };
    expect(body.roadblock).toBe("wallet_balance_low");
    expect(body.amount_usd).toBe(0.01);
    expect(body.next_step).toBe("lobstercash topup --amount 0.01");
  });

  it("fires flex_onboarding_required before balance checks when the agent profile is incomplete", async () => {
    const { apiKey, agentId } = await makeBoundKey(baseEnv);
    await seedAgent(baseEnv, agentId, { wallet_provider: "pay_sh" });

    const res = await postJson(
      "/v1/billing/topup-needed",
      { min_balance_uc: 10_000, wallet_balance_uc: 0 },
      { authorization: `Bearer ${apiKey}` },
    );

    expect(res.status).toBe(402);
    const body = (await res.json()) as { roadblock: string; next_step: string };
    expect(body.roadblock).toBe("flex_onboarding_required");
    expect(body.next_step).toBe("unbrowse setup");
  });

  it("returns no roadblock when supplied network and balance are compatible", async () => {
    const { apiKey, agentId } = await makeBoundKey(baseEnv);
    await seedCompleteFlexAgent(baseEnv, agentId);
    const res = await postJson(
      "/v1/billing/topup-needed",
      { min_balance_uc: 10_000, wallet_balance_uc: 10_000, requested_network: "solana-mainnet" },
      { authorization: `Bearer ${apiKey}` },
    );

    expect(res.status).toBe(200);
    const body = (await res.json()) as { roadblock_required: boolean; roadblock: string | null };
    expect(body.roadblock_required).toBe(false);
    expect(body.roadblock).toBe(null);
  });
});
