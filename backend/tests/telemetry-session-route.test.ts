import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { app } from "../src/index.js";
import type { Env } from "../src/types.js";
import { __resetNeonForTests, __setNeonFactoryForTests } from "../src/services/neon.js";

// Real Hono route, fake Neon client via __setNeonFactoryForTests. The
// route's validation, fingerprint derivation, rate-limit logic, and
// error mapping all run for real; only the network boundary (SQL execution)
// is stubbed.

type SqlCall = { query: string; params: unknown[] };

function makeFakeSql() {
  const calls: SqlCall[] = [];
  const sessions = new Map<string, Record<string, unknown>>();
  const rate = new Map<string, string>();

  const sql = Object.assign(
    async (strings: TemplateStringsArray, ...values: unknown[]): Promise<unknown[]> => {
      const query = strings.join("?").replace(/\s+/g, " ").trim();
      calls.push({ query, params: values });

      // CREATE TABLE bootstrap (from neon.ts initialize) — swallow.
      if (/^CREATE TABLE IF NOT EXISTS app_kv/i.test(query) || /^CREATE INDEX IF NOT EXISTS app_kv/i.test(query)) {
        return [];
      }

      // Rate-limit read
      if (/^SELECT value FROM app_kv WHERE namespace = \? AND key = \?/i.test(query)) {
        const [_ns, key] = values as [string, string];
        const v = rate.get(key);
        return v ? [{ value: v }] : [];
      }

      // Rate-limit write
      if (/^INSERT INTO app_kv/i.test(query)) {
        const [_ns, key, value] = values as [string, string, string];
        rate.set(key, value);
        return [];
      }

      // Session insert
      if (/^INSERT INTO telemetry_sessions/i.test(query)) {
        const [session_id, duration_ms_total, tool_calls_total, errors_total, reflection_status, events_json, agent_kind_fingerprint, mcp_version, platform, client_seed_fp] = values as [
          string, number | null, number | null, number | null, string, string, string, string | null, string | null, string | null,
        ];
        sessions.set(session_id, {
          session_id,
          duration_ms_total,
          tool_calls_total,
          errors_total,
          reflection_status,
          events_json,
          agent_kind_fingerprint,
          mcp_version,
          platform,
          client_seed_fp,
        });
        return [];
      }

      // Session delete
      if (/^DELETE FROM telemetry_sessions WHERE client_seed_fp = \?/i.test(query)) {
        const [fp] = values as [string];
        let count = 0;
        for (const [id, row] of sessions) {
          if (row.client_seed_fp === fp) {
            sessions.delete(id);
            count += 1;
          }
        }
        const arr: unknown[] = Array.from({ length: count });
        (arr as unknown as { count: number }).count = count;
        return arr;
      }

      return [];
    },
    {
      transaction: async (queries: unknown[]) => queries,
    },
  );
  return { sql, calls, sessions, rate };
}

let fake: ReturnType<typeof makeFakeSql>;
let env: Env;

beforeEach(() => {
  fake = makeFakeSql();
  __setNeonFactoryForTests((() => fake.sql) as unknown as typeof import("@neondatabase/serverless").neon);
  env = {
    API_KEY: "test",
    EMERGENTDB_API_KEY: "test",
    NEBIUS_API_KEY: "test",
    DATABASE_URL: "postgres://test-host/test",
    STATS_KV: {} as KVNamespace,
    ENVIRONMENT: "production",
    TURBOBOX_URL: "http://stub",
    R2_BUCKET: {} as R2Bucket,
    FAL_KEY: "test",
  } as Env;
});

afterEach(() => {
  __resetNeonForTests();
});

function makeRequest(body: unknown, headers: Record<string, string> = {}) {
  return new Request("http://localhost/v1/telemetry/session", {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify(body),
  });
}

describe("POST /v1/telemetry/session (Neon)", () => {
  test("happy path: stores session with sanitized events", async () => {
    const payload = {
      session_id: "sess-abc",
      events: [
        { event: "session_start", ts: new Date().toISOString(), mcp_version: "0.0.0", platform: "darwin-arm64", client_seed_fp: "deadbeefdeadbeef" },
        { event: "tool_start", ts: new Date().toISOString(), call_id: "c1", tool: "unbrowse_resolve" },
        { event: "tool_end", ts: new Date().toISOString(), call_id: "c1", tool: "unbrowse_resolve", duration_ms: 12, success: true },
        { event: "reflection", ts: new Date().toISOString(), intent_status: "achieved" },
        { event: "session_end", ts: new Date().toISOString(), duration_ms_total: 100, tool_calls_total: 1, errors_total: 0, reflection_status: "seen" },
      ],
    };
    const res = await app.fetch(makeRequest(payload, { "x-agent-kind-fingerprint": "fp1234fp1234fp12" }), env);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toMatchObject({ ok: true, session_id: "sess-abc", events_stored: 5 });

    const stored = fake.sessions.get("sess-abc");
    expect(stored).toBeDefined();
    expect(stored!.reflection_status).toBe("achieved");
    expect(stored!.agent_kind_fingerprint).toBe("fp1234fp1234fp12");
    expect(stored!.client_seed_fp).toBe("deadbeefdeadbeef");
  });

  test("rejects missing session_id", async () => {
    const res = await app.fetch(makeRequest({ events: [{ event: "x", ts: "t" }] }), env);
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ error: "session_id_required" });
  });

  test("rejects empty events", async () => {
    const res = await app.fetch(makeRequest({ session_id: "s1", events: [] }), env);
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ error: "events_required" });
  });

  test("rejects oversized payload", async () => {
    const huge = "x".repeat(300_000);
    const res = await app.fetch(
      new Request("http://localhost/v1/telemetry/session", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: huge,
      }),
      env,
    );
    expect(res.status).toBe(413);
  });

  test("rejects invalid event shape", async () => {
    const res = await app.fetch(makeRequest({ session_id: "s1", events: [{ event: "ok-event" /* missing ts */ }] }), env);
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ error: "invalid_event" });
  });

  test("rate-limits to 60 per fingerprint per minute", async () => {
    const fp = "ratelimitfp00000";
    const minute = Math.floor(Date.now() / 60_000);
    fake.rate.set(`telemetry-rate:${fp}:${minute}`, "60");

    const payload = {
      session_id: "rl-1",
      events: [{ event: "session_start", ts: new Date().toISOString() }],
    };
    const res = await app.fetch(makeRequest(payload, { "x-agent-kind-fingerprint": fp }), env);
    expect(res.status).toBe(429);
    expect(await res.json()).toMatchObject({ error: "rate_limited" });
  });

  test("503 when DATABASE_URL is not configured", async () => {
    const noDb = { ...env } as Env;
    noDb.DATABASE_URL = undefined;
    const payload = { session_id: "s1", events: [{ event: "session_start", ts: new Date().toISOString() }] };
    const res = await app.fetch(makeRequest(payload), noDb);
    expect(res.status).toBe(503);
    expect(await res.json()).toMatchObject({ error: "storage_not_configured" });
  });
});

describe("DELETE /v1/telemetry/sessions (Neon)", () => {
  test("deletes rows matching the seed fingerprint", async () => {
    const seed = "test-purge-seed";
    const bytes = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(seed));
    const derivedFp = Array.from(new Uint8Array(bytes)).map((b) => b.toString(16).padStart(2, "0")).join("").slice(0, 16);

    fake.sessions.set("purge-me", { session_id: "purge-me", client_seed_fp: derivedFp });
    fake.sessions.set("other-2", { session_id: "other-2", client_seed_fp: "other-fingerprint" });

    const res = await app.fetch(
      new Request(`http://localhost/v1/telemetry/sessions?seed=${encodeURIComponent(seed)}`, { method: "DELETE" }),
      env,
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean; deleted: number };
    expect(body.ok).toBe(true);
    expect(body.deleted).toBe(1);
    expect(fake.sessions.has("purge-me")).toBe(false);
    expect(fake.sessions.has("other-2")).toBe(true);
  });

  test("requires seed query param", async () => {
    const res = await app.fetch(new Request("http://localhost/v1/telemetry/sessions", { method: "DELETE" }), env);
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ error: "seed_required" });
  });
});
