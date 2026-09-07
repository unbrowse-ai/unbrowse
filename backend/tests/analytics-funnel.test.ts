import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import app from "../src/index.js";
import type { Env } from "../src/types.js";
import { statsKV } from "../src/services/kv.js";

const env: Env = {
  API_KEY: "admin",
  EMERGENTDB_API_KEY: "test",
  NEBIUS_API_KEY: "nebius",
  STATS_KV: {} as KVNamespace,
  ENVIRONMENT: "local-dev",
};

function isoHoursAgo(hours: number): string {
  return new Date(Date.now() - hours * 3600_000).toISOString();
}

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

describe("telemetry funnel analytics", () => {
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

  it("summarizes first-run funnel transitions and failures by install id", async () => {
    const events = [
      {
        install_id: "install-1",
        name: "install_session_started",
        source: "cli",
        host_type: "codex",
        created_at: isoHoursAgo(8),
      },
      {
        install_id: "install-1",
        name: "cli_invoked",
        source: "cli",
        host_type: "codex",
        created_at: isoHoursAgo(8),
      },
      {
        install_id: "install-1",
        name: "registration_succeeded",
        source: "cli",
        host_type: "codex",
        created_at: isoHoursAgo(7),
      },
      {
        install_id: "install-1",
        name: "resolve_started",
        source: "cli",
        host_type: "codex",
        created_at: isoHoursAgo(6),
      },
      {
        install_id: "install-1",
        name: "resolve_completed",
        source: "cli",
        host_type: "codex",
        created_at: isoHoursAgo(5),
        properties: { user_visible_result: true },
      },
      {
        install_id: "install-1",
        name: "resolve_completed",
        source: "cli",
        host_type: "codex",
        created_at: isoHoursAgo(4),
        properties: { user_visible_result: true },
      },
      {
        install_id: "install-2",
        name: "install_session_started",
        source: "cli",
        host_type: "cursor",
        created_at: isoHoursAgo(72),
      },
      {
        install_id: "install-2",
        name: "cli_invoked",
        source: "cli",
        host_type: "cursor",
        created_at: isoHoursAgo(72),
      },
      {
        install_id: "install-2",
        name: "resolve_started",
        source: "cli",
        host_type: "cursor",
        created_at: isoHoursAgo(71),
      },
      {
        install_id: "install-2",
        name: "resolve_failed",
        source: "cli",
        host_type: "cursor",
        created_at: isoHoursAgo(70),
        properties: {
          failure_stage: "execute",
          failure_reason: "timeout",
        },
      },
    ];

    for (const event of events) {
      const res = await app.fetch(new Request("http://local.test/v1/telemetry/events", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(event),
      }), env);
      expect(res.status).toBe(200);
    }

    const res = await app.fetch(new Request("http://local.test/v1/analytics/install-funnel?days=90", {
      headers: { Authorization: "Bearer admin" },
    }), env);
    expect(res.status).toBe(200);
    const body = await res.json() as {
      totals: {
        installs: number;
        cli_invoked: number;
        registrations: number;
        first_resolve_started: number;
        first_resolve_succeeded: number;
        second_success: number;
        repeat_success: number;
        abandonment_24h: number;
      };
      rates: {
        registration_from_cli: number;
        first_resolve_started_from_registered: number;
        first_resolve_succeeded_from_started: number;
        second_success_from_first_success: number;
      };
      failures: {
        total: number;
        top_stages: Array<{ key: string; count: number }>;
        top_reasons: Array<{ key: string; count: number }>;
      };
      hosts: Array<{
        host_type: string;
        installs: number;
        registrations: number;
        first_resolve_succeeded: number;
        second_success: number;
      }>;
    };

    expect(body.totals.installs).toBe(2);
    expect(body.totals.cli_invoked).toBe(2);
    expect(body.totals.registrations).toBe(1);
    expect(body.totals.first_resolve_started).toBe(2);
    expect(body.totals.first_resolve_succeeded).toBe(1);
    expect(body.totals.second_success).toBe(1);
    expect(body.totals.repeat_success).toBe(0);
    expect(body.totals.abandonment_24h).toBe(1);

    expect(body.rates.registration_from_cli).toBe(0.5);
    expect(body.rates.first_resolve_started_from_registered).toBe(1);
    expect(body.rates.first_resolve_succeeded_from_started).toBe(0.5);
    expect(body.rates.second_success_from_first_success).toBe(1);

    expect(body.failures.total).toBe(1);
    expect(body.failures.top_stages[0]).toEqual({ key: "execute", count: 1 });
    expect(body.failures.top_reasons[0]).toEqual({ key: "timeout", count: 1 });

    expect(body.hosts[0]).toEqual({
      host_type: "codex",
      installs: 1,
      registrations: 1,
      first_resolve_succeeded: 1,
      second_success: 1,
      first_resolve_started: 1,
      repeat_success: 0,
      power_users: 0,
    });
  });
});
