import { afterEach, describe, expect, it } from "bun:test";
import { __resetNeonForTests, __setNeonFactoryForTests } from "../src/services/neon.js";
import { buildLeaderboard } from "../src/services/economics.js";
import type { Env } from "../src/types.js";

const env: Env = {
  API_KEY: "admin",
  UNKEY_ROOT_KEY: "root",
  UNKEY_API_ID: "api",
  DATABASE_URL: "postgres://test",
  EMERGENTDB_API_KEY: "unused",
  NEBIUS_API_KEY: "nebius",
  STATS_KV: {} as KVNamespace,
  ENVIRONMENT: "production",
};

afterEach(() => {
  __resetNeonForTests();
});

describe("economics leaderboard Neon query shape", () => {
  it("builds the leaderboard from prefix scans instead of per-agent point lookups", async () => {
    let prefixScanCount = 0;
    let pointLookupCount = 0;

    const rowsByPrefix = new Map<string, unknown[]>([
      ["agent:%", [
        {
          key: "agent:agent-a",
          value: JSON.stringify({
            agent_id: "agent-a",
            name: "Agent A",
            created_at: "2026-01-01T00:00:00.000Z",
            skills_discovered: ["skill-a"],
            total_executions: 3,
            total_feedback_given: 0,
            tos_accepted_version: "2026-01-01",
            tos_accepted_at: "2026-01-01T00:00:00.000Z",
            activity_dates: ["2026-04-03"],
          }),
        },
        {
          key: "agent:agent-b",
          value: JSON.stringify({
            agent_id: "agent-b",
            name: "Agent B",
            created_at: "2026-01-02T00:00:00.000Z",
            skills_discovered: [],
            total_executions: 1,
            total_feedback_given: 0,
            tos_accepted_version: "2026-01-01",
            tos_accepted_at: "2026-01-02T00:00:00.000Z",
            activity_dates: [],
          }),
        },
      ]],
      ["tx:creator:%", [
        {
          key: "tx:creator:agent-a",
          value: JSON.stringify({
            agent_id: "agent-a",
            total_earned_uc: 1000,
            total_earned_usd: 0.001,
            total_fees_uc: 250,
            transaction_count: 1,
            first_transaction_at: "2026-04-03T00:00:00.000Z",
            last_transaction_at: "2026-04-03T00:00:00.000Z",
          }),
        },
      ]],
      ["attribution:indexer:%", [
        {
          key: "attribution:indexer:agent-a",
          value: JSON.stringify({
            indexer_id: "agent-a",
            total_credited_uc: 500,
            total_credited_usd: 0.0005,
            execution_count: 2,
            cumulative_delta: 0.4,
            avg_delta: 0.2,
            first_attributed_at: "2026-04-03T00:00:00.000Z",
            last_attributed_at: "2026-04-03T00:00:00.000Z",
          }),
        },
      ]],
      ["perf:agent:%", [
        {
          key: "perf:agent:agent-a",
          value: JSON.stringify({
            agent_id: "agent-a",
            event_count: 1,
            time_saved_events: 1,
            cost_saved_events: 0,
            total_actual_ms: 1000,
            total_baseline_ms: 3000,
            total_time_saved_ms: 2000,
            total_actual_cost_uc: 0,
            total_baseline_cost_uc: 0,
            total_cost_saved_uc: 0,
            total_paid_search_uc: 0,
            total_paid_execution_uc: 0,
            first_recorded_at: "2026-04-03T00:00:00.000Z",
            last_recorded_at: "2026-04-03T00:00:00.000Z",
          }),
        },
      ]],
    ]);

    const sql = Object.assign(
      async (strings: TemplateStringsArray, ...values: unknown[]): Promise<unknown[]> => {
        const query = strings.join(" ").replace(/\s+/g, " ").trim();
        if (query.startsWith("CREATE TABLE") || query.startsWith("CREATE INDEX")) {
          return [];
        }
        if (query.includes("SELECT key, value")) {
          prefixScanCount += 1;
          return rowsByPrefix.get(String(values[1])) ?? [];
        }
        if (query.includes("SELECT value")) {
          pointLookupCount += 1;
          return [];
        }
        throw new Error(`Unexpected query: ${query}`);
      },
      {
        transaction: async (queries: unknown[]) => queries,
      },
    );

    __setNeonFactoryForTests((() => sql) as unknown as typeof import("@neondatabase/serverless").neon);

    const leaderboard = await buildLeaderboard(env, 10);

    expect(leaderboard).toHaveLength(2);
    expect(leaderboard[0]?.agent_id).toBe("agent-a");
    expect(prefixScanCount).toBe(4);
    expect(pointLookupCount).toBe(0);
  });
});
