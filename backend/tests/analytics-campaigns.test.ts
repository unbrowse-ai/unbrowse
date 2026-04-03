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

describe("campaign feedback analytics", () => {
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

  it("joins landing, content, install, funnel, and session outcomes by campaign context", async () => {
    const shared = {
      channel: "x",
      campaign_id: "agent-builder-launch",
      content_id: "x-post-9",
      content_type: "x_post",
      inferred_icp: "agent-builder",
      variant_id: "agent-builder-v2",
      experiment_id: "homepage",
    };

    const webEvents = [
      {
        visitor_id: "visitor-1",
        session_id: "web-session-1",
        name: "landing_page_viewed",
        path: "/?utm_campaign=agent-builder-launch",
        referrer: "https://x.com/getFoundry/status/9",
        created_at: isoHoursAgo(8),
        properties: shared,
      },
      {
        visitor_id: "visitor-1",
        session_id: "web-session-1",
        name: "install_command_copied",
        path: "/",
        referrer: "https://x.com/getFoundry/status/9",
        created_at: isoHoursAgo(7),
        properties: shared,
      },
      {
        visitor_id: "visitor-2",
        session_id: "web-session-2",
        name: "content_page_viewed",
        path: "/blog/personal-agents?utm_campaign=agent-builder-launch",
        referrer: "https://x.com/getFoundry/status/9",
        created_at: isoHoursAgo(7),
        properties: {
          ...shared,
          content_id: "personal-agents",
          content_type: "blog_article",
        },
      },
    ];

    for (const event of webEvents) {
      const res = await app.fetch(new Request("http://local.test/v1/telemetry/web", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(event),
      }), env);
      expect(res.status).toBe(200);
    }

    const installRes = await app.fetch(new Request("http://local.test/v1/telemetry/install", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        install_id: "install-1",
        source: "cli-first-seen",
        host_type: "codex",
        skill: "unbrowse",
        status: "installed",
        created_at: isoHoursAgo(6),
        properties: shared,
      }),
    }), env);
    expect(installRes.status).toBe(200);

    const funnelEvents = [
      {
        install_id: "install-1",
        session_id: "trace-1",
        name: "cli_invoked",
        source: "cli",
        host_type: "codex",
        created_at: isoHoursAgo(5),
        properties: shared,
      },
      {
        install_id: "install-1",
        session_id: "trace-1",
        name: "registration_succeeded",
        source: "cli",
        host_type: "codex",
        created_at: isoHoursAgo(4),
        properties: shared,
      },
      {
        install_id: "install-1",
        session_id: "trace-1",
        name: "resolve_started",
        source: "cli",
        host_type: "codex",
        created_at: isoHoursAgo(3),
        properties: shared,
      },
      {
        install_id: "install-1",
        session_id: "trace-1",
        name: "resolve_completed",
        source: "cli",
        host_type: "codex",
        created_at: isoHoursAgo(2),
        properties: shared,
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

    const sessionRes = await app.fetch(new Request("http://local.test/v1/analytics/sessions", {
      method: "POST",
      headers: {
        Authorization: "Bearer admin",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        session_id: "trace-1",
        started_at: isoHoursAgo(3),
        completed_at: isoHoursAgo(2),
        trace_version: "campaign-trace",
        api_calls: 1,
        discovery_queries: 1,
        cached_skill_calls: 1,
        fresh_index_calls: 0,
        browser_mode: "replaced",
        success: true,
        ...shared,
      }),
    }), env);
    expect(sessionRes.status).toBe(200);

    const res = await app.fetch(new Request("http://local.test/v1/analytics/campaigns?campaign_id=agent-builder-launch", {
      headers: { Authorization: "Bearer admin" },
    }), env);
    expect(res.status).toBe(200);
    const body = await res.json() as {
      rows: Array<{
        channel: string;
        campaign_id: string;
        content_id?: string;
        landing_sessions: number;
        content_page_sessions: number;
        install_command_copies: number;
        reported_installs: number;
        cli_invoked: number;
        registrations: number;
        first_resolve_succeeded: number;
        total_sessions: number;
        successful_sessions: number;
      }>;
    };

    expect(body.rows).toEqual(expect.arrayContaining([
      expect.objectContaining({
        channel: "x",
        campaign_id: "agent-builder-launch",
        content_id: "x-post-9",
        landing_sessions: 1,
        install_command_copies: 1,
        reported_installs: 1,
        cli_invoked: 1,
        registrations: 1,
        first_resolve_succeeded: 1,
        total_sessions: 1,
        successful_sessions: 1,
      }),
      expect.objectContaining({
        channel: "x",
        campaign_id: "agent-builder-launch",
        content_id: "personal-agents",
        content_page_sessions: 1,
      }),
    ]));
  });
});
