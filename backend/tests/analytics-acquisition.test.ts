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

describe("acquisition analytics", () => {
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

  it("summarizes landing to install-copy leakage by session", async () => {
    const events = [
      {
        visitor_id: "visitor-1",
        session_id: "session-1",
        name: "landing_page_viewed",
        path: "/",
        referrer: "https://x.com/getFoundry",
        created_at: isoHoursAgo(3),
        properties: {
          utm_source: "x",
          utm_medium: "social",
          utm_campaign: "agent_builder_launch",
          utm_content: "routes_not_clicks",
          utm_term: "playwright alternative",
          referrer_host: "x.com",
          inferred_icp: "agent-builder",
        },
      },
      {
        visitor_id: "visitor-1",
        session_id: "session-1",
        name: "install_section_viewed",
        path: "/",
        referrer: "https://x.com/getFoundry",
        created_at: isoHoursAgo(2),
      },
      {
        visitor_id: "visitor-1",
        session_id: "session-1",
        name: "landing_section_viewed",
        path: "/",
        referrer: "https://x.com/getFoundry",
        created_at: isoHoursAgo(2),
        properties: { section_id: "demo", variant_id: "openclaw-normie-v1", icp: "openclaw-normie", experiment_id: "homepage" },
      },
      {
        visitor_id: "visitor-1",
        session_id: "session-1",
        name: "install_command_copied",
        path: "/",
        referrer: "https://x.com/getFoundry",
        created_at: isoHoursAgo(1),
      },
      {
        visitor_id: "visitor-1",
        session_id: "session-1",
        name: "first_task_section_viewed",
        path: "/",
        referrer: "https://x.com/getFoundry",
        created_at: isoHoursAgo(1),
      },
      {
        visitor_id: "visitor-1",
        session_id: "session-1",
        name: "first_task_command_copied",
        path: "/",
        referrer: "https://x.com/getFoundry",
        created_at: isoHoursAgo(1),
      },
      {
        visitor_id: "visitor-1",
        session_id: "session-1",
        name: "icp_path_clicked",
        path: "/",
        referrer: "https://x.com/getFoundry",
        created_at: isoHoursAgo(1),
        properties: { target_id: "openclaw-normie", variant_id: "openclaw-normie-v1", icp: "openclaw-normie", experiment_id: "homepage" },
      },
      {
        visitor_id: "visitor-2",
        session_id: "session-2",
        name: "landing_page_viewed",
        path: "/",
        referrer: "",
        created_at: isoHoursAgo(6),
        properties: {
          utm_source: "direct",
        },
      },
      {
        visitor_id: "visitor-3",
        session_id: "session-3",
        name: "landing_page_viewed",
        path: "/",
        referrer: "https://www.google.com/search?q=unbrowse",
        created_at: isoHoursAgo(5),
        properties: {
          utm_source: "google",
          utm_medium: "cpc",
          utm_campaign: "openclaw_normie",
          utm_content: "install_one_plugin",
          utm_term: "openclaw plugin",
          gclid: "gclid-123",
          referrer_host: "www.google.com",
          inferred_icp: "openclaw-normie",
        },
      },
      {
        visitor_id: "visitor-3",
        session_id: "session-3",
        name: "install_section_viewed",
        path: "/",
        referrer: "https://www.google.com/search?q=unbrowse",
        created_at: isoHoursAgo(4),
      },
      {
        visitor_id: "visitor-3",
        session_id: "session-3",
        name: "first_task_section_viewed",
        path: "/",
        referrer: "https://www.google.com/search?q=unbrowse",
        created_at: isoHoursAgo(3),
      },
    ];

    for (const event of events) {
      const res = await app.fetch(new Request("http://local.test/v1/telemetry/web", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(event),
      }), env);
      expect(res.status).toBe(200);
    }

    const res = await app.fetch(new Request("http://local.test/v1/analytics/acquisition?days=30", {
      headers: { Authorization: "Bearer admin" },
    }), env);
    expect(res.status).toBe(200);
    const body = await res.json() as {
      totals: {
        visitors: number;
        sessions: number;
        landing_views: number;
        install_section_views: number;
        first_task_section_views: number;
        install_command_copies: number;
        first_task_command_copies: number;
        landing_without_install_view: number;
        install_view_without_copy: number;
        first_task_view_without_copy: number;
        install_copy_without_first_task: number;
      };
      rates: {
        install_section_view_from_landing: number;
        install_copy_from_landing: number;
        install_copy_from_install_view: number;
        first_task_view_from_install_copy: number;
        first_task_copy_from_first_task_view: number;
        first_task_copy_from_install_copy: number;
      };
      top_referrers: Array<{ referrer: string; sessions: number }>;
      sections: Array<{ section_id: string; sessions: number; share_of_landing: number; install_copy_rate_after_view: number }>;
      icp_paths: Array<{ target_id: string; sessions: number; click_through_rate_from_landing: number }>;
      dimensions: {
        utm_source: Array<{ value: string; sessions: number; share_of_landing: number; install_copy_rate_after_view: number }>;
        utm_campaign: Array<{ value: string; sessions: number; share_of_landing: number; install_copy_rate_after_view: number }>;
        utm_content: Array<{ value: string; sessions: number; share_of_landing: number; install_copy_rate_after_view: number }>;
        utm_term: Array<{ value: string; sessions: number; share_of_landing: number; install_copy_rate_after_view: number }>;
        inferred_icp: Array<{ value: string; sessions: number; share_of_landing: number; install_copy_rate_after_view: number }>;
      };
    };

    expect(body.totals.visitors).toBe(3);
    expect(body.totals.sessions).toBe(3);
    expect(body.totals.landing_views).toBe(3);
    expect(body.totals.install_section_views).toBe(2);
    expect(body.totals.first_task_section_views).toBe(2);
    expect(body.totals.install_command_copies).toBe(1);
    expect(body.totals.first_task_command_copies).toBe(1);
    expect(body.totals.landing_without_install_view).toBe(1);
    expect(body.totals.install_view_without_copy).toBe(1);
    expect(body.totals.first_task_view_without_copy).toBe(1);
    expect(body.totals.install_copy_without_first_task).toBe(0);
    expect(body.rates.install_section_view_from_landing).toBe(0.67);
    expect(body.rates.install_copy_from_landing).toBe(0.33);
    expect(body.rates.install_copy_from_install_view).toBe(0.5);
    expect(body.rates.first_task_view_from_install_copy).toBe(1);
    expect(body.rates.first_task_copy_from_first_task_view).toBe(0.5);
    expect(body.rates.first_task_copy_from_install_copy).toBe(1);
    expect(body.top_referrers).toEqual([
      { referrer: "direct", sessions: 1 },
      { referrer: "www.google.com", sessions: 1 },
      { referrer: "x.com", sessions: 1 },
    ]);
    expect(body.sections).toEqual(expect.arrayContaining([
      expect.objectContaining({
        section_id: "install",
        sessions: 2,
        share_of_landing: 0.67,
        install_copy_rate_after_view: 0.5,
      }),
      expect.objectContaining({
        section_id: "demo",
        sessions: 1,
        share_of_landing: 0.33,
        install_copy_rate_after_view: 1,
      }),
    ]));
    expect(body.icp_paths).toEqual([
      {
        target_id: "openclaw-normie",
        sessions: 1,
        click_through_rate_from_landing: 0.33,
      },
    ]);
    expect(body.dimensions.utm_source).toEqual(expect.arrayContaining([
      expect.objectContaining({
        value: "google",
        sessions: 1,
        share_of_landing: 0.33,
        install_copy_rate_after_view: 0,
      }),
      expect.objectContaining({
        value: "x",
        sessions: 1,
        share_of_landing: 0.33,
        install_copy_rate_after_view: 1,
      }),
    ]));
    expect(body.dimensions.utm_campaign).toEqual(expect.arrayContaining([
      expect.objectContaining({ value: "agent_builder_launch", sessions: 1 }),
      expect.objectContaining({ value: "openclaw_normie", sessions: 1 }),
    ]));
    expect(body.dimensions.inferred_icp).toEqual(expect.arrayContaining([
      expect.objectContaining({ value: "agent-builder", sessions: 1 }),
      expect.objectContaining({ value: "openclaw-normie", sessions: 1 }),
    ]));
  });
});
