import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import app from "../src/index.js";
import type { AgentProfile, Env } from "../src/types.js";
import { statsKV } from "../src/services/kv.js";
import { recordAttribution } from "../src/services/attribution.js";
import { recordGraphFee } from "../src/services/fees.js";
import { recordTransaction } from "../src/services/transactions.js";
import { CURRENT_TOS_VERSION } from "../src/tos.js";

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

    throw new Error(`Unexpected fetch: ${url.toString()}`);
  };
}

function agentIdForToken(token: string): string {
  return `staging_${token.slice(0, 8)}`;
}

async function putProfile(profile: AgentProfile): Promise<void> {
  await statsKV(env).put(`agent:${profile.agent_id}`, JSON.stringify(profile));
}

function makeProfile(token: string, overrides: Partial<AgentProfile> = {}): AgentProfile {
  const agentId = agentIdForToken(token);
  return {
    agent_id: agentId,
    name: token,
    created_at: "2026-01-01T00:00:00.000Z",
    skills_discovered: [],
    total_executions: 0,
    total_feedback_given: 0,
    tos_accepted_version: CURRENT_TOS_VERSION,
    tos_accepted_at: "2026-01-01T00:00:00.000Z",
    activity_dates: [],
    ...overrides,
  };
}

describe("dashboard and leaderboard routes", () => {
  const store = new Map<string, string>();
  const originalFetch = globalThis.fetch;

  beforeEach(async () => {
    globalThis.fetch = createMockFetch(store) as typeof fetch;
    store.clear();
    await statsKV(env).resetSplitIndex();
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it("returns a zero-state dashboard for a brand-new agent", async () => {
    const token = "alpha123456";
    await putProfile(makeProfile(token, { name: "Alpha Agent" }));

    const res = await app.fetch(new Request("http://local.test/v1/dashboard/me", {
      headers: { Authorization: `Bearer ${token}` },
    }), env);
    expect(res.status).toBe(200);

    const body = await res.json() as {
      economics: { spent_usd: number; total_earned_usd: number; platform_fees_paid_usd: number };
      savings: {
        baseline_time_ms: number | null;
        actual_time_ms: number | null;
        speedup_ratio: number | null;
        baseline_cost_uc: number | null;
        actual_cost_uc: number | null;
        time_saved_ms: number | null;
        cost_saved_uc: number | null;
      };
      rank: { position: number | null };
    };

    expect(body.economics.spent_usd).toBe(0);
    expect(body.economics.total_earned_usd).toBe(0);
    expect(body.economics.platform_fees_paid_usd).toBe(0);
    expect(body.savings.baseline_time_ms).toBeNull();
    expect(body.savings.actual_time_ms).toBeNull();
    expect(body.savings.speedup_ratio).toBeNull();
    expect(body.savings.baseline_cost_uc).toBeNull();
    expect(body.savings.actual_cost_uc).toBeNull();
    expect(body.savings.time_saved_ms).toBeNull();
    expect(body.savings.cost_saved_uc).toBeNull();
    expect(body.rank.position).toBeNull();
  });

  it("claims wallets, rejects conflicts, and serves wallet dashboards", async () => {
    const alphaToken = "alpha123456";
    const betaToken = "beta123456";
    const alphaId = agentIdForToken(alphaToken);

    await putProfile(makeProfile(alphaToken, {
      name: "Alpha Agent",
      total_executions: 4,
      total_feedback_given: 1,
      skills_discovered: ["skill-a"],
    }));
    await putProfile(makeProfile(betaToken, {
      name: "Beta Agent",
      total_executions: 1,
    }));

    const claimRes = await app.fetch(new Request("http://local.test/v1/agents/wallet", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${alphaToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ wallet_address: "wallet-alpha" }),
    }), env);
    expect(claimRes.status).toBe(200);

    const repeatClaimRes = await app.fetch(new Request("http://local.test/v1/agents/wallet", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${alphaToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ wallet_address: "wallet-alpha" }),
    }), env);
    expect(repeatClaimRes.status).toBe(200);

    const conflictingRes = await app.fetch(new Request("http://local.test/v1/agents/wallet", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${betaToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ wallet_address: "wallet-alpha" }),
    }), env);
    expect(conflictingRes.status).toBe(409);

    await recordTransaction(env, {
      transaction_id: "tx-wallet",
      consumer_id: agentIdForToken("otherwallet"),
      creator_id: alphaId,
      skill_id: "skill-wallet",
      endpoint_id: "execute",
      price_usd: 0.003,
    });

    const walletDashRes = await app.fetch(new Request("http://local.test/v1/dashboard/wallet/wallet-alpha"), env);
    expect(walletDashRes.status).toBe(200);
    const walletDash = await walletDashRes.json() as {
      profile: AgentProfile;
      economics: { total_earned_usd: number };
    };
    expect(walletDash.profile.agent_id).toBe(alphaId);
    expect(walletDash.profile.wallet_address).toBe("wallet-alpha");
    expect(walletDash.economics.total_earned_usd).toBeGreaterThan(0);

    const unknownWalletRes = await app.fetch(new Request("http://local.test/v1/dashboard/wallet/unknown-wallet"), env);
    expect(unknownWalletRes.status).toBe(404);
  });

  it("aggregates spend, earnings, attribution, and savings in dashboard/me", async () => {
    const alphaToken = "alpha123456";
    const betaToken = "beta123456";
    const gammaToken = "gamma123456";
    const alphaId = agentIdForToken(alphaToken);
    const betaId = agentIdForToken(betaToken);
    const gammaId = agentIdForToken(gammaToken);

    await putProfile(makeProfile(alphaToken, {
      name: "Alpha Agent",
      created_at: "2026-01-01T00:00:00.000Z",
      total_executions: 7,
      total_feedback_given: 3,
      skills_discovered: ["skill-a", "skill-b"],
      activity_dates: ["2026-04-01"],
    }));
    await putProfile(makeProfile(betaToken, { name: "Beta Agent", total_executions: 2, skills_discovered: ["skill-c"] }));
    await putProfile(makeProfile(gammaToken, { name: "Gamma Agent", total_executions: 1 }));

    await recordTransaction(env, {
      transaction_id: "tx-spend",
      consumer_id: alphaId,
      creator_id: betaId,
      skill_id: "skill-market",
      endpoint_id: "search",
      price_usd: 0.005,
    });
    await recordTransaction(env, {
      transaction_id: "tx-earn",
      consumer_id: gammaId,
      creator_id: alphaId,
      skill_id: "skill-alpha",
      endpoint_id: "execute",
      price_usd: 0.004,
    });
    await recordGraphFee(env, alphaId, "search");

    await recordAttribution(env, {
      execution_id: "exec-1",
      skill_id: "skill-alpha",
      endpoint_id: "execute",
      indexer_id: alphaId,
      reliability_score: 0.9,
      next_best_score: 0.1,
    });

    const perfReq = {
      search_ms: 120,
      get_skill_ms: 25,
      execute_ms: 80,
      total_ms: 225,
      source: "marketplace",
      cache_hit: false,
      candidates_found: 3,
      candidates_tried: 1,
      tokens_saved: 1200,
      response_bytes: 400,
      time_saved_pct: 85,
      tokens_saved_pct: 50,
      baseline_total_ms: 5000,
      actual_total_ms: 225,
      time_saved_ms: 4775,
      actual_cost_uc: 1000,
      cost_saved_uc: 2500,
      paid_search_uc: 1000,
    };
    const perfRes = await app.fetch(new Request("http://local.test/v1/stats/perf", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${alphaToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(perfReq),
    }), env);
    expect(perfRes.status).toBe(200);

    const res = await app.fetch(new Request("http://local.test/v1/dashboard/me", {
      headers: { Authorization: `Bearer ${alphaToken}` },
    }), env);
    expect(res.status).toBe(200);

    const body = await res.json() as {
      economics: {
        spent_usd: number;
        creator_earned_usd: number;
        attribution_earned_usd: number;
        total_earned_usd: number;
        platform_fees_paid_usd: number;
        graph_fees_paid_usd: number;
        skill_spend_usd: number;
      };
      savings: {
        baseline_time_ms: number | null;
        actual_time_ms: number | null;
        time_saved_ms: number | null;
        time_saved_hours: number | null;
        speedup_ratio: number | null;
        baseline_cost_uc: number | null;
        baseline_cost_usd: number | null;
        actual_cost_uc: number | null;
        actual_cost_usd: number | null;
        cost_saved_uc: number | null;
        cost_saved_usd: number | null;
      };
      activity: { total_executions: number; skills_discovered: number; total_feedback_given: number };
      recent_transactions: Array<{ transaction_id: string; direction: string }>;
      rank: { position: number | null; contribution_score: number };
    };

    expect(body.economics.skill_spend_usd).toBe(0.005);
    expect(body.economics.graph_fees_paid_usd).toBe(0.001);
    expect(body.economics.spent_usd).toBe(0.006);
    expect(body.economics.creator_earned_usd).toBe(0.0032);
    expect(body.economics.attribution_earned_usd).toBe(0.00017);
    expect(body.economics.total_earned_usd).toBe(0.00337);
    expect(body.economics.platform_fees_paid_usd).toBe(0.002);
    expect(body.savings.baseline_time_ms).toBe(5000);
    expect(body.savings.actual_time_ms).toBe(225);
    expect(body.savings.time_saved_ms).toBe(4775);
    expect(body.savings.time_saved_hours).toBeCloseTo(0.0013, 4);
    expect(body.savings.speedup_ratio).toBeCloseTo(22.2222, 4);
    expect(body.savings.baseline_cost_uc).toBeNull();
    expect(body.savings.baseline_cost_usd).toBeNull();
    expect(body.savings.actual_cost_uc).toBe(1000);
    expect(body.savings.actual_cost_usd).toBe(0.001);
    expect(body.savings.cost_saved_uc).toBe(2500);
    expect(body.savings.cost_saved_usd).toBe(0.0025);
    expect(body.activity).toEqual({
      total_executions: 7,
      skills_discovered: 2,
      total_feedback_given: 3,
    });
    expect(body.recent_transactions.map((tx) => tx.transaction_id).sort()).toEqual(["tx-earn", "tx-spend"]);
    expect(body.rank.position).toBe(1);
    expect(body.rank.contribution_score).toBeGreaterThan(0);
  });

  it("orders leaderboard by score, then tie-breakers, and excludes zero-activity agents", async () => {
    const alphaToken = "alphaaaaa1";
    const betaToken = "betaaaaa2";
    const zeroToken = "zeroaaaa3";
    const alphaId = agentIdForToken(alphaToken);
    const betaId = agentIdForToken(betaToken);

    await putProfile(makeProfile(alphaToken, {
      name: "Alpha",
      created_at: "2026-01-01T00:00:00.000Z",
      total_executions: 5,
      skills_discovered: ["a", "b"],
    }));
    await putProfile(makeProfile(betaToken, {
      name: "Beta",
      created_at: "2026-02-01T00:00:00.000Z",
      total_executions: 5,
      skills_discovered: ["a", "b"],
    }));
    await putProfile(makeProfile(zeroToken, { name: "Zero" }));

    await recordTransaction(env, {
      transaction_id: "tx-alpha",
      consumer_id: agentIdForToken("other1111"),
      creator_id: alphaId,
      skill_id: "skill-a",
      price_usd: 0.01,
    });
    await recordTransaction(env, {
      transaction_id: "tx-beta",
      consumer_id: agentIdForToken("other2222"),
      creator_id: betaId,
      skill_id: "skill-b",
      price_usd: 0.01,
    });

    const res = await app.fetch(new Request("http://local.test/v1/leaderboard?limit=10"), env);
    expect(res.status).toBe(200);
    const body = await res.json() as { entries: Array<{ name: string; contribution_score: number }> };

    expect(body.entries.map((entry) => entry.name)).toEqual(["Alpha", "Beta"]);
    expect(body.entries[0].contribution_score).toBe(body.entries[1].contribution_score);
  });

  it("rejects malformed savings telemetry and accumulates valid perf payloads", async () => {
    const token = "perf123456";
    const agentId = agentIdForToken(token);
    await putProfile(makeProfile(token, { name: "Perf Agent" }));

    const invalidRes = await app.fetch(new Request("http://local.test/v1/stats/perf", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        search_ms: 1,
        get_skill_ms: 1,
        execute_ms: 1,
        total_ms: 3,
        source: "marketplace",
        cache_hit: false,
        candidates_found: 1,
        candidates_tried: 1,
        tokens_saved: 0,
        response_bytes: 20,
        time_saved_pct: 0,
        tokens_saved_pct: 0,
        time_saved_ms: -1,
      }),
    }), env);

    expect(invalidRes.status).toBe(400);

    for (const timing of [
      { total_ms: 200, actual_total_ms: 200, time_saved_ms: 4000, cost_saved_uc: 1000, paid_search_uc: 1000 },
      { total_ms: 300, actual_total_ms: 300, time_saved_ms: 5000, cost_saved_uc: 2500, paid_execution_uc: 5000 },
    ]) {
      const res = await app.fetch(new Request("http://local.test/v1/stats/perf", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          search_ms: 20,
          get_skill_ms: 10,
          execute_ms: 30,
          source: "marketplace",
          cache_hit: false,
          candidates_found: 1,
          candidates_tried: 1,
          tokens_saved: 100,
          response_bytes: 50,
          time_saved_pct: 80,
          tokens_saved_pct: 20,
          baseline_total_ms: 4200,
          ...timing,
        }),
      }), env);
      expect(res.status).toBe(200);
    }

    const dashRes = await app.fetch(new Request("http://local.test/v1/dashboard/me", {
      headers: { Authorization: `Bearer ${token}` },
    }), env);
    expect(dashRes.status).toBe(200);
    const body = await dashRes.json() as {
      savings: {
        baseline_time_ms: number | null;
        actual_time_ms: number | null;
        speedup_ratio: number | null;
        baseline_cost_uc: number | null;
        actual_cost_uc: number | null;
        time_saved_ms: number | null;
        cost_saved_uc: number | null;
      };
      economics: { paid_execution_usd: number };
    };

    expect(body.savings.baseline_time_ms).toBe(8400);
    expect(body.savings.actual_time_ms).toBe(500);
    expect(body.savings.speedup_ratio).toBe(16.8);
    expect(body.savings.baseline_cost_uc).toBeNull();
    expect(body.savings.actual_cost_uc).toBeNull();
    expect(body.savings.time_saved_ms).toBe(9000);
    expect(body.savings.cost_saved_uc).toBe(3500);
    expect(body.economics.paid_execution_usd).toBe(0.005);
    expect(agentId).toContain("staging_");
  });
});
