import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import app from "../src/index.js";
import type { Env } from "../src/types.js";
import { statsKV } from "../src/services/kv.js";
import {
  getLandingHomepageExperimentConfig,
  mintLandingHomepageToken,
  resolveLandingHomepageToken,
} from "../src/services/landing-experiments.js";

const env: Env = {
  API_KEY: "admin",
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

describe("landing homepage experiments", () => {
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

  it("assigns sticky live variants and never serves shadow copy", async () => {
    const first = await app.fetch(new Request("http://local.test/v1/landing/homepage/assign", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ visitor_id: "visitor-sticky" }),
    }), env);

    expect(first.status).toBe(200);
    const firstBody = await first.json() as {
      assignment_cookie: string;
      assignment: { experiment_id: string; variant_id: string };
      status: string;
    };

    expect(["active", "canary"]).toContain(firstBody.status);

    const second = await app.fetch(new Request("http://local.test/v1/landing/homepage/assign", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        visitor_id: "visitor-sticky",
        current_assignment: firstBody.assignment_cookie,
      }),
    }), env);

    expect(second.status).toBe(200);
    const secondBody = await second.json() as {
      assignment_cookie: string;
      assignment: { experiment_id: string; variant_id: string };
      status: string;
    };

    expect(secondBody.assignment.experiment_id).toBe(firstBody.assignment.experiment_id);
    expect(secondBody.assignment.variant_id).toBe(firstBody.assignment.variant_id);
    expect(secondBody.assignment_cookie).toBe(firstBody.assignment_cookie);
  });

  it("rejects tampered or expired landing tokens", async () => {
    const config = await getLandingHomepageExperimentConfig(env);
    const liveVariant = config.variants.find((variant) => variant.status === "active") ?? config.variants[0];
    const minted = await mintLandingHomepageToken(env, {
      experiment_id: config.experiment_id,
      variant_id: liveVariant.variant_id,
      visitor_id: "visitor-1",
      session_id: "session-1",
    });

    const valid = await resolveLandingHomepageToken(env, minted.token);
    expect(valid?.variant_id).toBe(liveVariant.variant_id);

    const tampered = `${minted.token.slice(0, -1)}x`;
    expect(await resolveLandingHomepageToken(env, tampered)).toBeNull();

    const realNow = Date.now;
    Date.now = () => Date.parse(minted.claims.expires_at) + 1000;
    try {
      expect(await resolveLandingHomepageToken(env, minted.token)).toBeNull();
    } finally {
      Date.now = realNow;
    }
  });

  it("joins landing sessions to install and first resolve analytics via landing token", async () => {
    const assignRes = await app.fetch(new Request("http://local.test/v1/landing/homepage/assign", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ visitor_id: "visitor-analytics" }),
    }), env);
    const assigned = await assignRes.json() as {
      assignment: { experiment_id: string; variant_id: string };
    };

    const webEvents = [
      { name: "landing_page_viewed", created_at: isoHoursAgo(6), properties: { utm_campaign: "browser-replacement-april" } },
      { name: "hero_viewed", created_at: isoHoursAgo(6), properties: { utm_campaign: "browser-replacement-april" } },
      { name: "scroll_depth_reached", created_at: isoHoursAgo(5), properties: { bucket: 75, utm_campaign: "browser-replacement-april" } },
      { name: "section_viewed", created_at: isoHoursAgo(5), properties: { section_id: "install", utm_campaign: "browser-replacement-april" } },
      { name: "install_section_viewed", created_at: isoHoursAgo(5), properties: { section_id: "install", utm_campaign: "browser-replacement-april" } },
      { name: "exploration_page_clicked", created_at: isoHoursAgo(4), properties: { target_id: "docs", utm_campaign: "browser-replacement-april" } },
      { name: "page_exploration_depth_updated", created_at: isoHoursAgo(4), properties: { depth: 2, utm_campaign: "browser-replacement-april" } },
      { name: "install_command_copied", created_at: isoHoursAgo(3), properties: { tab_id: "cli", tokenized: true, utm_campaign: "browser-replacement-april" } },
    ];

    for (const event of webEvents) {
      const res = await app.fetch(new Request("http://local.test/v1/telemetry/web", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "cf-connecting-ip": "203.0.113.42",
        },
        body: JSON.stringify({
          visitor_id: "visitor-analytics",
          session_id: "session-analytics",
          experiment_id: assigned.assignment.experiment_id,
          variant_id: assigned.assignment.variant_id,
          path: "/?utm_campaign=browser-replacement-april",
          referrer: "https://x.com/getFoundry",
          ...event,
        }),
      }), env);
      expect(res.status).toBe(200);
    }

    const tokenRes = await app.fetch(new Request("http://local.test/v1/landing/homepage/token", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        experiment_id: assigned.assignment.experiment_id,
        variant_id: assigned.assignment.variant_id,
        visitor_id: "visitor-analytics",
        session_id: "session-analytics",
      }),
    }), env);
    expect(tokenRes.status).toBe(200);
    const tokenBody = await tokenRes.json() as { token: string };

    const installRes = await app.fetch(new Request("http://local.test/v1/telemetry/install", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        install_id: "install-analytics",
        landing_token: tokenBody.token,
        source: "host",
        host_type: "codex",
        status: "installed",
        created_at: isoHoursAgo(2),
      }),
    }), env);
    expect(installRes.status).toBe(200);

    const funnelEvents = [
      { name: "setup_completed", created_at: isoHoursAgo(2) },
      { name: "registration_succeeded", created_at: isoHoursAgo(1) },
      { name: "resolve_started", created_at: isoHoursAgo(1) },
      { name: "resolve_completed", created_at: isoHoursAgo(1), properties: { user_visible_result: true } },
    ];

    for (const event of funnelEvents) {
      const res = await app.fetch(new Request("http://local.test/v1/telemetry/events", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          install_id: "install-analytics",
          landing_token: tokenBody.token,
          source: "cli",
          host_type: "codex",
          ...event,
        }),
      }), env);
      expect(res.status).toBe(200);
    }

    const analyticsRes = await app.fetch(new Request("http://local.test/v1/analytics/landing-funnel?days=30", {
      headers: { Authorization: "Bearer admin" },
    }), env);
    expect(analyticsRes.status).toBe(200);
    const summary = await analyticsRes.json() as {
      experiment_id: string;
      variants: Array<{
        variant_id: string;
        landing_visitors: number;
        landing_sessions: number;
        hero_views: number;
        install_section_views: number;
        install_command_copies: number;
        install_started: number;
        setup_completed: number;
        registrations: number;
        first_resolve_started: number;
        first_resolve_succeeded: number;
        avg_exploration_depth: number;
        max_scroll_bucket_reached: number;
        rates: {
          first_resolve_succeeded_from_landing: number;
          first_resolve_succeeded_from_install_started: number;
        };
        top_referrers: Array<{ referrer: string; sessions: number }>;
        top_campaigns: Array<{ campaign: string; sessions: number }>;
      }>;
    };

    expect(summary.experiment_id).toBe(assigned.assignment.experiment_id);

    const variant = summary.variants.find((entry) => entry.variant_id === assigned.assignment.variant_id);
    expect(variant).toBeTruthy();
    expect(variant?.landing_visitors).toBe(1);
    expect(variant?.landing_sessions).toBe(1);
    expect(variant?.hero_views).toBe(1);
    expect(variant?.install_section_views).toBe(1);
    expect(variant?.install_command_copies).toBe(1);
    expect(variant?.install_started).toBe(1);
    expect(variant?.setup_completed).toBe(1);
    expect(variant?.registrations).toBe(1);
    expect(variant?.first_resolve_started).toBe(1);
    expect(variant?.first_resolve_succeeded).toBe(1);
    expect(variant?.avg_exploration_depth).toBe(2);
    expect(variant?.max_scroll_bucket_reached).toBe(75);
    expect(variant?.rates.first_resolve_succeeded_from_landing).toBe(1);
    expect(variant?.rates.first_resolve_succeeded_from_install_started).toBe(1);
    expect(variant?.top_referrers).toEqual([{ referrer: "x.com", sessions: 1 }]);
    expect(variant?.top_campaigns).toEqual([{ campaign: "browser-replacement-april", sessions: 1 }]);
  });
});
