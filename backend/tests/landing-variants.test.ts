import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import app from "../src/index.js";
import type { Env } from "../src/types.js";
import { statsKV } from "../src/services/kv.js";

const env: Env = {
  API_KEY: "admin",
  LANDING_PUBLISH_KEY: "landing-secret",
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

describe("landing variants api", () => {
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

  // route not yet implemented — POST /v1/landing/variants/publish, GET /v1/landing/resolve
  it.skip("publishes and resolves an active ICP variant", async () => {
    const publishRes = await app.fetch(new Request("http://local.test/v1/landing/variants/publish", {
      method: "POST",
      headers: {
        Authorization: "Bearer landing-secret",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        variant_id: "openclaw-normie-v1",
        name: "OpenClaw normie v1",
        icp: "openclaw-normie",
        experiment_id: "homepage",
        status: "active",
        weight: 3,
        content: {
          hero_title: "Install one plugin",
          hero_highlight: "skip browser waiting.",
        },
      }),
    }), env);

    expect(publishRes.status).toBe(200);

    const resolveRes = await app.fetch(new Request("http://local.test/v1/landing/resolve?icp=openclaw-normie&experiment_id=homepage"), env);
    expect(resolveRes.status).toBe(200);
    const resolved = await resolveRes.json() as {
      variant: { variant_id: string; icp: string; content: { hero_title?: string; hero_highlight?: string } };
    };
    expect(resolved.variant.variant_id).toBe("openclaw-normie-v1");
    expect(resolved.variant.icp).toBe("openclaw-normie");
    expect(resolved.variant.content.hero_title).toBe("Install one plugin");
  });

  // route not yet implemented — POST /v1/landing/variants/publish, GET /v1/landing/summary
  it.skip("summarizes variant-scoped landing telemetry", async () => {
    const publishRes = await app.fetch(new Request("http://local.test/v1/landing/variants/publish", {
      method: "POST",
      headers: {
        Authorization: "Bearer landing-secret",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        variant_id: "openclaw-normie-v2",
        name: "OpenClaw normie v2",
        icp: "openclaw-normie",
        experiment_id: "homepage",
        status: "active",
        weight: 1,
      }),
    }), env);
    expect(publishRes.status).toBe(200);

    const events = [
      {
        visitor_id: "visitor-1",
        session_id: "session-1",
        name: "landing_page_viewed",
        path: "/?icp=openclaw-normie",
        created_at: isoHoursAgo(4),
        properties: { variant_id: "openclaw-normie-v2", icp: "openclaw-normie", experiment_id: "homepage" },
      },
      {
        visitor_id: "visitor-1",
        session_id: "session-1",
        name: "install_section_viewed",
        path: "/?icp=openclaw-normie",
        created_at: isoHoursAgo(3),
        properties: { variant_id: "openclaw-normie-v2", icp: "openclaw-normie", experiment_id: "homepage" },
      },
      {
        visitor_id: "visitor-1",
        session_id: "session-1",
        name: "install_command_copied",
        path: "/?icp=openclaw-normie",
        created_at: isoHoursAgo(2),
        properties: { variant_id: "openclaw-normie-v2", icp: "openclaw-normie", experiment_id: "homepage" },
      },
      {
        visitor_id: "visitor-2",
        session_id: "session-2",
        name: "landing_page_viewed",
        path: "/?icp=openclaw-normie",
        created_at: isoHoursAgo(1),
        properties: { variant_id: "openclaw-normie-v2", icp: "openclaw-normie", experiment_id: "homepage" },
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

    const summaryRes = await app.fetch(new Request("http://local.test/v1/landing/summary?icp=openclaw-normie", {
      headers: { Authorization: "Bearer landing-secret" },
    }), env);
    expect(summaryRes.status).toBe(200);
    const summary = await summaryRes.json() as {
      variants: Array<{
        variant_id: string;
        landing_views: number;
        install_section_views: number;
        install_command_copies: number;
        install_section_view_rate: number;
        install_command_copy_rate: number;
      }>;
    };

    expect(summary.variants[0]).toEqual(expect.objectContaining({
      variant_id: "openclaw-normie-v2",
      landing_views: 2,
      install_section_views: 1,
      install_command_copies: 1,
      install_section_view_rate: 0.5,
      install_command_copy_rate: 0.5,
    }));
  });
});
