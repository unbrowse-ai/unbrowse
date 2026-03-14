import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import app from "../src/index.js";
import type { Env } from "../src/types.js";
import { statsKV } from "../src/services/kv.js";

const env: Env = {
  API_KEY: "admin",
  UNKEY_ROOT_KEY: "root",
  UNKEY_API_ID: "api",
  EMERGENTDB_API_KEY: "test",
  NEBIUS_API_KEY: "nebius",
  STATS_KV: {} as KVNamespace,
  ENVIRONMENT: "staging",
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

describe("install telemetry analytics", () => {
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

  it("reports which installs never invoke the CLI", async () => {
    const installEvents = [
      {
        install_id: "install-1",
        source: "host",
        host_type: "codex",
        skill: "unbrowse",
        status: "installed",
        created_at: isoHoursAgo(12),
      },
      {
        install_id: "install-2",
        source: "setup",
        host_type: "cursor",
        skill: "unbrowse",
        status: "started",
        created_at: isoHoursAgo(48),
      },
    ];

    for (const event of installEvents) {
      const res = await app.fetch(new Request("http://local.test/v1/telemetry/install", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(event),
      }), env);
      expect(res.status).toBe(200);
    }

    const funnelEvents = [
      {
        install_id: "install-1",
        name: "cli_invoked",
        source: "cli",
        host_type: "codex",
        created_at: isoHoursAgo(11),
      },
      {
        install_id: "install-1",
        name: "registration_succeeded",
        source: "cli",
        host_type: "codex",
        created_at: isoHoursAgo(10),
      },
      {
        install_id: "install-1",
        name: "resolve_started",
        source: "cli",
        host_type: "codex",
        created_at: isoHoursAgo(9),
      },
      {
        install_id: "install-1",
        name: "resolve_completed",
        source: "cli",
        host_type: "codex",
        created_at: isoHoursAgo(8),
        properties: { user_visible_result: true },
      },
    ];

    for (const event of funnelEvents) {
      const res = await app.fetch(new Request("http://local.test/v1/telemetry/events", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(event),
      }), env);
      expect(res.status).toBe(200);
    }

    const res = await app.fetch(new Request("http://local.test/v1/analytics/install?days=90"), env);
    expect(res.status).toBe(200);
    const body = await res.json() as {
      totals: {
        reported_installs: number;
        host_reported_installs: number;
        setup_reported_installs: number;
        invoked_installs: number;
        uninvoked_installs: number;
        registered_installs: number;
        first_resolve_started: number;
        first_resolve_succeeded: number;
      };
      rates: {
        invoked_from_reported_install: number;
        first_resolve_succeeded_from_reported_install: number;
      };
      hosts: Array<{
        host_type: string;
        installs: number;
        invoked: number;
        registered: number;
        first_resolve_started: number;
        first_resolve_succeeded: number;
      }>;
    };

    expect(body.totals.reported_installs).toBe(2);
    expect(body.totals.host_reported_installs).toBe(1);
    expect(body.totals.setup_reported_installs).toBe(1);
    expect(body.totals.invoked_installs).toBe(1);
    expect(body.totals.uninvoked_installs).toBe(1);
    expect(body.totals.registered_installs).toBe(1);
    expect(body.totals.first_resolve_started).toBe(1);
    expect(body.totals.first_resolve_succeeded).toBe(1);

    expect(body.rates.invoked_from_reported_install).toBe(0.5);
    expect(body.rates.first_resolve_succeeded_from_reported_install).toBe(0.5);

    expect(body.hosts[0]).toEqual({
      host_type: "codex",
      installs: 1,
      invoked: 1,
      registered: 1,
      first_resolve_started: 1,
      first_resolve_succeeded: 1,
    });
  });
});
