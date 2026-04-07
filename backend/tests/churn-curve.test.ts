import { createHmac } from "crypto";
import { describe, expect, it, beforeEach, afterEach } from "bun:test";
import app from "../src/index.js";
import type { Env } from "../src/types.js";
import { clearKVCacheForTests } from "../src/services/kv.js";

const env: Env = {
  API_KEY: "admin",
  UNKEY_ROOT_KEY: "root",
  UNKEY_API_ID: "api",
  EMERGENTDB_API_KEY: "test",
  NEBIUS_API_KEY: "nebius",
  STATS_KV: {
    put: async () => {},
    get: async () => null,
  } as unknown as KVNamespace,
  ENVIRONMENT: "staging",
  RELEASE_MANIFEST_SIGNING_SECRET: "release-secret",
};

function signedReleaseHeaders() {
  const manifest = JSON.stringify({
    schema_version: 1,
    release_version: "2.11.0",
    git_sha: "git-a",
    code_hash: "code-a",
    trace_version: "trace-a",
    issued_at: "2026-04-02T00:00:00.000Z",
  });
  const signature = createHmac("sha256", env.RELEASE_MANIFEST_SIGNING_SECRET!)
    .update(manifest)
    .digest("base64url");
  return {
    "X-Unbrowse-Release-Manifest": Buffer.from(manifest, "utf8").toString("base64url"),
    "X-Unbrowse-Release-Signature": signature,
  };
}

function hoursAgo(h: number): string {
  return new Date(Date.now() - h * 3600_000).toISOString();
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

    if (url.pathname.startsWith("/graph/")) {
      if (url.pathname === "/graph/search") {
        return Response.json({ results: [] });
      }
      return Response.json({ ok: true });
    }

    throw new Error(`Unexpected fetch: ${url.toString()}`);
  };
}

describe("churn-curve endpoint", () => {
  const store = new Map<string, string>();
  const originalFetch = globalThis.fetch;

  beforeEach(() => {
    globalThis.fetch = createMockFetch(store) as typeof fetch;
    store.clear();
    clearKVCacheForTests();
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    clearKVCacheForTests();
  });

  /** Seed a funnel event via the telemetry POST route (goes through recordFunnelEvent → KV index). */
  async function seedEvent(install_id: string, name: string, created_at: string) {
    const res = await app.fetch(
      new Request("http://local.test/v1/telemetry/events", {
        method: "POST",
        headers: { "Content-Type": "application/json", ...signedReleaseHeaders() },
        body: JSON.stringify({ install_id, name, source: "cli", host_type: "cli", created_at }),
      }),
      env,
    );
    if (res.status !== 200) {
      throw new Error(`seedEvent failed: ${res.status} ${await res.text()}`);
    }
  }

  function authHeaders() {
    return {
      Authorization: `Bearer ${createHmac("sha256", env.API_KEY).update("__admin__").digest("hex")}`,
      ...signedReleaseHeaders(),
    };
  }

  it("returns 401 without auth", async () => {
    const res = await app.fetch(
      new Request("http://local.test/v1/analytics/churn-curve"),
      env,
    );
    expect(res.status).toBe(401);
  });

  it("returns empty buckets when no events exist", async () => {
    const res = await app.fetch(
      new Request("http://local.test/v1/analytics/churn-curve", {
        headers: authHeaders(),
      }),
      env,
    );
    expect(res.status).toBe(200);
    const body = await res.json() as any;
    expect(body.total_installs).toBe(0);
    expect(body.anchor).toBe("install");
    expect(body.buckets).toBeArray();
    expect(body.buckets.length).toBeGreaterThan(0);
    expect(body.stage_latency).toBeArray();
  });

  it("correctly categorizes abandoned vs converted installs", async () => {
    const userA = "user-a-" + crypto.randomUUID();
    const userB = "user-b-" + crypto.randomUUID();
    const userC = "user-c-" + crypto.randomUUID();

    // User A: installed 50h ago, resolved at ~2h offset
    await seedEvent(userA, "cli_invoked", hoursAgo(50));
    await seedEvent(userA, "registration_succeeded", hoursAgo(49));
    await seedEvent(userA, "resolve_started", hoursAgo(48));
    await seedEvent(userA, "resolve_completed", hoursAgo(48));

    // User B: installed 50h ago, never resolved
    await seedEvent(userB, "cli_invoked", hoursAgo(50));
    await seedEvent(userB, "registration_succeeded", hoursAgo(49));

    // User C: installed 50h ago, resolved at ~30h offset
    await seedEvent(userC, "cli_invoked", hoursAgo(50));
    await seedEvent(userC, "registration_succeeded", hoursAgo(49));
    await seedEvent(userC, "resolve_started", hoursAgo(20));
    await seedEvent(userC, "resolve_completed", hoursAgo(20));

    const res = await app.fetch(
      new Request("http://local.test/v1/analytics/churn-curve?offsets=6,24,48,72", {
        headers: authHeaders(),
      }),
      env,
    );
    expect(res.status).toBe(200);
    const body = await res.json() as any;

    expect(body.total_installs).toBe(3);
    expect(body.buckets).toHaveLength(4);

    // At 6h: A converted (resolved at ~2h offset), B+C abandoned
    const b6 = body.buckets.find((b: any) => b.offset_hours === 6);
    expect(b6.converted).toBe(1);
    expect(b6.abandoned).toBe(2);

    // At 24h: A converted, B+C still abandoned (C resolved at 30h > 24h)
    const b24 = body.buckets.find((b: any) => b.offset_hours === 24);
    expect(b24.converted).toBe(1);
    expect(b24.abandoned).toBe(2);

    // At 48h: A+C converted, B abandoned
    const b48 = body.buckets.find((b: any) => b.offset_hours === 48);
    expect(b48.converted).toBe(2);
    expect(b48.abandoned).toBe(1);
  });

  it("respects anchor=registration", async () => {
    const userId = "user-reg-" + crypto.randomUUID();

    await seedEvent(userId, "cli_invoked", hoursAgo(100));
    await seedEvent(userId, "registration_succeeded", hoursAgo(50));
    await seedEvent(userId, "resolve_completed", hoursAgo(45));

    const res = await app.fetch(
      new Request("http://local.test/v1/analytics/churn-curve?anchor=registration&offsets=4,6,24", {
        headers: authHeaders(),
      }),
      env,
    );
    expect(res.status).toBe(200);
    const body = await res.json() as any;

    expect(body.anchor).toBe("registration");
    // Registered 50h ago, resolved 45h ago → 5h offset from registration
    const b4 = body.buckets.find((b: any) => b.offset_hours === 4);
    expect(b4.abandoned).toBe(1); // resolved at 5h > 4h window
    const b6 = body.buckets.find((b: any) => b.offset_hours === 6);
    expect(b6.converted).toBe(1); // resolved at 5h < 6h window
  });

  it("includes stage latency with percentiles", async () => {
    for (let i = 0; i < 10; i++) {
      const uid = `latency-${i}-${crypto.randomUUID()}`;
      const baseH = 100 + i;
      await seedEvent(uid, "cli_invoked", hoursAgo(baseH));
      await seedEvent(uid, "setup_completed", hoursAgo(baseH - 0.1));
      await seedEvent(uid, "registration_succeeded", hoursAgo(baseH - 0.5));
      await seedEvent(uid, "resolve_started", hoursAgo(baseH - 1));
      await seedEvent(uid, "resolve_completed", hoursAgo(baseH - 1.5));
    }

    const res = await app.fetch(
      new Request("http://local.test/v1/analytics/churn-curve", {
        headers: authHeaders(),
      }),
      env,
    );
    expect(res.status).toBe(200);
    const body = await res.json() as any;

    expect(body.stage_latency).toBeArray();
    expect(body.stage_latency.length).toBe(6);

    const installToSuccess = body.stage_latency.find(
      (s: any) => s.from === "install" && s.to === "first_resolve_succeeded",
    );
    expect(installToSuccess).toBeDefined();
    expect(installToSuccess.samples).toBe(10);
    expect(installToSuccess.median_ms).toBeGreaterThan(0);
    expect(installToSuccess.p25_ms).toBeLessThanOrEqual(installToSuccess.median_ms);
    expect(installToSuccess.median_ms).toBeLessThanOrEqual(installToSuccess.p75_ms);
    expect(installToSuccess.p75_ms).toBeLessThanOrEqual(installToSuccess.p95_ms);
  });

  it("marks pending installs correctly", async () => {
    const userId = "fresh-" + crypto.randomUUID();
    await seedEvent(userId, "cli_invoked", hoursAgo(0.5));

    const res = await app.fetch(
      new Request("http://local.test/v1/analytics/churn-curve?offsets=1,24", {
        headers: authHeaders(),
      }),
      env,
    );
    expect(res.status).toBe(200);
    const body = await res.json() as any;

    const b1 = body.buckets.find((b: any) => b.offset_hours === 1);
    expect(b1.pending).toBe(1);
    expect(b1.abandoned).toBe(0);
    expect(b1.converted).toBe(0);
  });
});
