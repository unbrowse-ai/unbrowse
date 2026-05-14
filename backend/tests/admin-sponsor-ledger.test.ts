/**
 * Day 5 (Genesis Creatures) — `GET /v1/admin/sponsor-ledger` route test.
 *
 * Exercises the real Hono app at the network boundary: requests go through
 * `app.fetch`, the same code path Cloudflare Workers hit in prod. No mocks
 * of the route handler, ADMIN_KEY check, or LocalKV reads — only the env
 * shape is synthetic (every Env field needed by the handler is present).
 *
 * The middleware writes sponsor ledger rows to `statsKV(env)`. When
 * `ENVIRONMENT="local-dev"`, that returns an in-process `LocalKV` keyed by
 * the "stats" namespace. The tests seed rows directly into that namespace,
 * then assert the admin handler reads them back through the same path —
 * end-to-end with no transport stubs.
 *
 * Per CLAUDE.md "Never mock in tests": the test exercises every layer
 * (Authorization parsing, ADMIN_KEY compare, statsKV dispatch, listWithValues
 * prefix scan, JSON parse, agent_id filter, since filter, limit slice, sort).
 * Anything that fails in prod will fail here.
 */

import { beforeEach, describe, expect, test } from "bun:test";
import { app } from "../src/index.js";
import type { Env } from "../src/types.js";
import { LocalKV, clearKVCacheForTests } from "../src/services/kv.js";
import type { SponsorLedgerRow } from "../src/middleware/sponsor.js";

const ADMIN_KEY = "test-admin-secret-key";

function makeEnv(opts?: { withAdminKey?: boolean }): Env {
  return {
    API_KEY: "test-api-key",
    EMERGENTDB_API_KEY: "x",
    NEBIUS_API_KEY: "x",
    TURBOBOX_URL: "x",
    FAL_KEY: "x",
    R2_BUCKET: {} as R2Bucket,
    STATS_KV: {} as KVNamespace,
    ENVIRONMENT: "local-dev",
    PAYMENTS_ENABLED: "true",
    ADMIN_KEY: opts?.withAdminKey === false ? undefined : ADMIN_KEY,
  };
}

function makeReq(path: string, headers: Record<string, string> = {}): Request {
  return new Request(`http://local.test${path}`, { headers });
}

function seedLedgerRow(row: Partial<SponsorLedgerRow> & { ledger_id: string }): SponsorLedgerRow {
  const full: SponsorLedgerRow = {
    ledger_id: row.ledger_id,
    kind: "sponsor",
    agent_id: row.agent_id ?? "agent-X",
    skill_id: row.skill_id ?? "skill-test",
    amount_uc: row.amount_uc ?? 1000, // $0.001 USDC = 1000 atomic units
    creator_wallet: row.creator_wallet ?? "So1Creator99999999999999999999999999",
    settled_tx: row.settled_tx ?? "0xtx-abcdef",
    settled_at: row.settled_at ?? "2026-05-14T12:00:00.000Z",
  };
  const kv = new LocalKV("stats");
  void kv.put(`sponsor:ledger:${full.ledger_id}`, JSON.stringify(full));
  return full;
}

beforeEach(() => {
  // Each test starts with an empty stats LocalKV. Cache + store are reset.
  clearKVCacheForTests("stats");
});

describe("GET /v1/admin/sponsor-ledger — auth", () => {
  test("missing Authorization header returns 401", async () => {
    const env = makeEnv();
    const res = await app.fetch(makeReq("/v1/admin/sponsor-ledger"), env);
    expect(res.status).toBe(401);
    const body = await res.json() as { error?: string };
    expect(body.error).toBe("unauthorized");
    // Never echo configured key in the error.
    expect(JSON.stringify(body)).not.toContain(ADMIN_KEY);
  });

  test("wrong bearer token returns 401", async () => {
    const env = makeEnv();
    const res = await app.fetch(
      makeReq("/v1/admin/sponsor-ledger", { Authorization: "Bearer not-the-admin-key" }),
      env,
    );
    expect(res.status).toBe(401);
    const body = await res.json() as { error?: string };
    expect(body.error).toBe("unauthorized");
    expect(JSON.stringify(body)).not.toContain(ADMIN_KEY);
  });

  test("ADMIN_KEY unset returns 401 even with a bearer header", async () => {
    // Refuse-to-enable: when the operator hasn't set ADMIN_KEY, the admin
    // surface stays closed regardless of header contents.
    const env = makeEnv({ withAdminKey: false });
    const res = await app.fetch(
      makeReq("/v1/admin/sponsor-ledger", { Authorization: "Bearer anything" }),
      env,
    );
    expect(res.status).toBe(401);
  });

  test("non-Bearer scheme returns 401", async () => {
    const env = makeEnv();
    const res = await app.fetch(
      makeReq("/v1/admin/sponsor-ledger", { Authorization: `Basic ${ADMIN_KEY}` }),
      env,
    );
    expect(res.status).toBe(401);
  });
});

describe("GET /v1/admin/sponsor-ledger — data", () => {
  test("correct auth + empty ledger returns rows:[], count:0", async () => {
    const env = makeEnv();
    const res = await app.fetch(
      makeReq("/v1/admin/sponsor-ledger", { Authorization: `Bearer ${ADMIN_KEY}` }),
      env,
    );
    expect(res.status).toBe(200);
    const body = await res.json() as {
      rows: unknown[]; count: number; filter_applied: { limit: number };
    };
    expect(body.rows).toEqual([]);
    expect(body.count).toBe(0);
    expect(body.filter_applied.limit).toBe(100);
  });

  test("correct auth + 2 seeded rows returns both with transformed shape", async () => {
    seedLedgerRow({
      ledger_id: "spr-2026-05-14-aaaaaaaa",
      agent_id: "agent-A",
      skill_id: "skill-search",
      amount_uc: 5000,
      creator_wallet: "So1Creator-A",
      settled_tx: "0xtxA",
      settled_at: "2026-05-14T10:00:00.000Z",
    });
    seedLedgerRow({
      ledger_id: "spr-2026-05-14-bbbbbbbb",
      agent_id: "agent-B",
      skill_id: "skill-fetch",
      amount_uc: 1000,
      creator_wallet: "So1Creator-B",
      settled_tx: "0xtxB",
      settled_at: "2026-05-14T11:00:00.000Z",
    });

    const env = makeEnv();
    const res = await app.fetch(
      makeReq("/v1/admin/sponsor-ledger", { Authorization: `Bearer ${ADMIN_KEY}` }),
      env,
    );
    expect(res.status).toBe(200);
    const body = await res.json() as {
      rows: Array<{
        ledger_id: string; agent_id: string; skill_id: string;
        amount_usdc: string; creator_wallet: string; settled_tx: string;
        created_at_ms: number; kind: string;
      }>;
      count: number;
    };
    expect(body.count).toBe(2);
    expect(body.rows).toHaveLength(2);

    // Most-recent-first sort
    expect(body.rows[0].ledger_id).toBe("spr-2026-05-14-bbbbbbbb");
    expect(body.rows[1].ledger_id).toBe("spr-2026-05-14-aaaaaaaa");

    // Shape transform: amount_uc → amount_usdc (string), settled_at → created_at_ms
    const rowA = body.rows.find((r) => r.ledger_id === "spr-2026-05-14-aaaaaaaa")!;
    expect(rowA.amount_usdc).toBe("5000");
    expect(rowA.created_at_ms).toBe(Date.parse("2026-05-14T10:00:00.000Z"));
    expect(rowA.kind).toBe("sponsor");
    expect(rowA.agent_id).toBe("agent-A");
    expect(rowA.skill_id).toBe("skill-search");
    expect(rowA.creator_wallet).toBe("So1Creator-A");
    expect(rowA.settled_tx).toBe("0xtxA");
  });

  test("limit=1 returns one row (most recent)", async () => {
    seedLedgerRow({
      ledger_id: "spr-old",
      settled_at: "2026-05-14T08:00:00.000Z",
    });
    seedLedgerRow({
      ledger_id: "spr-new",
      settled_at: "2026-05-14T18:00:00.000Z",
    });

    const env = makeEnv();
    const res = await app.fetch(
      makeReq("/v1/admin/sponsor-ledger?limit=1", {
        Authorization: `Bearer ${ADMIN_KEY}`,
      }),
      env,
    );
    expect(res.status).toBe(200);
    const body = await res.json() as {
      rows: Array<{ ledger_id: string }>; count: number; filter_applied: { limit: number };
    };
    expect(body.count).toBe(1);
    expect(body.rows[0].ledger_id).toBe("spr-new");
    expect(body.filter_applied.limit).toBe(1);
  });

  test("limit cap is 1000 — request with limit=99999 clamps", async () => {
    const env = makeEnv();
    const res = await app.fetch(
      makeReq("/v1/admin/sponsor-ledger?limit=99999", {
        Authorization: `Bearer ${ADMIN_KEY}`,
      }),
      env,
    );
    const body = await res.json() as { filter_applied: { limit: number } };
    expect(body.filter_applied.limit).toBe(1000);
  });

  test("agent_id filter returns only matching rows", async () => {
    seedLedgerRow({ ledger_id: "spr-A1", agent_id: "agent-A" });
    seedLedgerRow({ ledger_id: "spr-A2", agent_id: "agent-A" });
    seedLedgerRow({ ledger_id: "spr-B1", agent_id: "agent-B" });

    const env = makeEnv();
    const res = await app.fetch(
      makeReq("/v1/admin/sponsor-ledger?agent_id=agent-A", {
        Authorization: `Bearer ${ADMIN_KEY}`,
      }),
      env,
    );
    const body = await res.json() as {
      rows: Array<{ ledger_id: string; agent_id: string }>;
      count: number;
      filter_applied: { agent_id?: string };
    };
    expect(body.count).toBe(2);
    expect(body.rows.every((r) => r.agent_id === "agent-A")).toBe(true);
    expect(body.filter_applied.agent_id).toBe("agent-A");
  });

  test("since filter excludes rows older than threshold", async () => {
    const oldMs = Date.parse("2026-05-14T01:00:00.000Z");
    const newMs = Date.parse("2026-05-14T20:00:00.000Z");
    const cutoffMs = Date.parse("2026-05-14T12:00:00.000Z");
    seedLedgerRow({ ledger_id: "spr-old", settled_at: new Date(oldMs).toISOString() });
    seedLedgerRow({ ledger_id: "spr-new", settled_at: new Date(newMs).toISOString() });

    const env = makeEnv();
    const res = await app.fetch(
      makeReq(`/v1/admin/sponsor-ledger?since=${cutoffMs}`, {
        Authorization: `Bearer ${ADMIN_KEY}`,
      }),
      env,
    );
    const body = await res.json() as {
      rows: Array<{ ledger_id: string }>;
      count: number;
      filter_applied: { since?: number };
    };
    expect(body.count).toBe(1);
    expect(body.rows[0].ledger_id).toBe("spr-new");
    expect(body.filter_applied.since).toBe(cutoffMs);
  });

  test("corrupted ledger rows are skipped, not 500", async () => {
    // Write a JSON-shaped but invalid row alongside a good one.
    const kv = new LocalKV("stats");
    await kv.put("sponsor:ledger:spr-broken", "not-valid-json{");
    await kv.put(
      "sponsor:ledger:spr-wrong-kind",
      JSON.stringify({ kind: "other", ledger_id: "spr-wrong-kind" }),
    );
    seedLedgerRow({ ledger_id: "spr-good" });

    const env = makeEnv();
    const res = await app.fetch(
      makeReq("/v1/admin/sponsor-ledger", { Authorization: `Bearer ${ADMIN_KEY}` }),
      env,
    );
    expect(res.status).toBe(200);
    const body = await res.json() as { rows: Array<{ ledger_id: string }>; count: number };
    expect(body.count).toBe(1);
    expect(body.rows[0].ledger_id).toBe("spr-good");
  });
});
