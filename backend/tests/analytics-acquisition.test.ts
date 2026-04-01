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
        name: "install_command_copied",
        path: "/",
        referrer: "https://x.com/getFoundry",
        created_at: isoHoursAgo(1),
      },
      {
        visitor_id: "visitor-2",
        session_id: "session-2",
        name: "landing_page_viewed",
        path: "/",
        referrer: "",
        created_at: isoHoursAgo(6),
      },
      {
        visitor_id: "visitor-3",
        session_id: "session-3",
        name: "landing_page_viewed",
        path: "/",
        referrer: "https://www.google.com/search?q=unbrowse",
        created_at: isoHoursAgo(5),
      },
      {
        visitor_id: "visitor-3",
        session_id: "session-3",
        name: "install_section_viewed",
        path: "/",
        referrer: "https://www.google.com/search?q=unbrowse",
        created_at: isoHoursAgo(4),
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
        install_command_copies: number;
        landing_without_install_view: number;
        install_view_without_copy: number;
      };
      rates: {
        install_section_view_from_landing: number;
        install_copy_from_landing: number;
        install_copy_from_install_view: number;
      };
      top_referrers: Array<{ referrer: string; sessions: number }>;
    };

    expect(body.totals.visitors).toBe(3);
    expect(body.totals.sessions).toBe(3);
    expect(body.totals.landing_views).toBe(3);
    expect(body.totals.install_section_views).toBe(2);
    expect(body.totals.install_command_copies).toBe(1);
    expect(body.totals.landing_without_install_view).toBe(1);
    expect(body.totals.install_view_without_copy).toBe(1);
    expect(body.rates.install_section_view_from_landing).toBe(0.67);
    expect(body.rates.install_copy_from_landing).toBe(0.33);
    expect(body.rates.install_copy_from_install_view).toBe(0.5);
    expect(body.top_referrers).toEqual([
      { referrer: "direct", sessions: 1 },
      { referrer: "www.google.com", sessions: 1 },
      { referrer: "x.com", sessions: 1 },
    ]);
  });
});
