/**
 * Day 6 (Genesis Dominion) — `GET /v1/analytics/payments` route test.
 *
 * Exercises the real Hono app at the network boundary (same pattern as
 * `admin-sponsor-ledger.test.ts`): every assertion goes through `app.fetch`,
 * exactly the code path Cloudflare Workers hit in prod. The middleware
 * writes ledger rows into `statsKV(env)`; in `ENVIRONMENT="local-dev"` that
 * returns an in-process `LocalKV` keyed by the "stats" namespace, which the
 * test seeds directly.
 *
 * Per CLAUDE.md "Never mock in tests": no stubs of the auth check, no fake
 * KV, no patched aggregator. The only synthetic surface is the `Env` object
 * itself (every field the handler reads is present).
 *
 * Honest scope: the route returns 8 fields per the v6.16 plan, but only
 * `sponsor_settled_usd_24h` and `sponsor_recouped_usd_24h` are computed
 * from real data today. The other six fields are `"0.00"` / `0` placeholders
 * gated by `_partial: true` and `_instrumented_fields`. Tests assert the
 * schema shape on all 8 keys, but only check arithmetic on the two real ones.
 */

import { beforeEach, describe, expect, test } from "bun:test";
import { app } from "../src/index.js";
import type { Env } from "../src/types.js";
import { LocalKV, clearKVCacheForTests } from "../src/services/kv.js";
import type { SponsorLedgerRow } from "../src/middleware/sponsor.js";

const ADMIN_KEY = "test-admin-secret-key";
const ROUTE = "/v1/analytics/payments";

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
    ADMIN_KEY: opts?.withAdminKey === false ? undefined : ADMIN_KEY,
  };
}

function makeReq(path: string, headers: Record<string, string> = {}): Request {
  return new Request(`http://local.test${path}`, { headers });
}

/** Day-6 Worker-1 will add `payment_method` to sponsor rows. Until then the
 *  ledger writer doesn't emit it. Tests pass it as an OPTIONAL extra so
 *  recoup-on-Flex behaviour is exercised end-to-end without touching the
 *  middleware. */
/** Day-6 Worker-1 added `payment_method?: "direct_spl" | "flex"` to the
 *  source-of-truth `SponsorLedgerRow` type in `middleware/sponsor.ts`. Tests
 *  exercise both rails plus the legacy/undefined case (older rows where the
 *  middleware didn't emit the field at all). */
type SponsorLedgerRowSeed = Partial<SponsorLedgerRow> & {
  ledger_id: string;
  payment_method?: "flex" | "direct_spl";
};

function seedLedgerRow(row: SponsorLedgerRowSeed): SponsorLedgerRow & {
  payment_method?: string;
} {
  const full = {
    ledger_id: row.ledger_id,
    kind: "sponsor" as const,
    agent_id: row.agent_id ?? "agent-X",
    skill_id: row.skill_id ?? "skill-test",
    amount_uc: row.amount_uc ?? 1_000_000, // $1.00 default
    creator_wallet: row.creator_wallet ?? "So1Creator99999999999999999999999999",
    settled_tx: row.settled_tx ?? "0xtx-abcdef",
    settled_at: row.settled_at ?? new Date().toISOString(),
    ...(row.payment_method !== undefined ? { payment_method: row.payment_method } : {}),
  };
  const kv = new LocalKV("stats");
  void kv.put(`sponsor:ledger:${full.ledger_id}`, JSON.stringify(full));
  return full;
}

interface AnalyticsPaymentsBody {
  platform_cut_usd_24h: string;
  platform_cut_usd_30d: string;
  sponsor_settled_usd_24h: string;
  sponsor_recouped_usd_24h: string;
  creator_payouts_usd_24h: string;
  flex_escrows_active: number;
  flex_pending_settlements: number;
  flex_holds_in_memory: number;
  _partial: boolean;
  _instrumented_fields: string[];
  _todo?: string;
}

async function fetchPayments(env: Env, headers?: Record<string, string>) {
  return app.fetch(makeReq(ROUTE, headers), env);
}

beforeEach(() => {
  clearKVCacheForTests("stats");
});

describe("GET /v1/analytics/payments — auth", () => {
  test("missing Authorization header → 401", async () => {
    const env = makeEnv();
    const res = await fetchPayments(env);
    expect(res.status).toBe(401);
    const body = (await res.json()) as { error?: string };
    expect(body.error).toBe("unauthorized");
    expect(JSON.stringify(body)).not.toContain(ADMIN_KEY);
  });

  test("wrong bearer token → 401", async () => {
    const env = makeEnv();
    const res = await fetchPayments(env, { Authorization: "Bearer wrong-token" });
    expect(res.status).toBe(401);
  });

  test("ADMIN_KEY unset → 401 even with bearer header", async () => {
    const env = makeEnv({ withAdminKey: false });
    const res = await fetchPayments(env, { Authorization: "Bearer anything" });
    expect(res.status).toBe(401);
  });

  test("non-Bearer scheme → 401", async () => {
    const env = makeEnv();
    const res = await fetchPayments(env, { Authorization: `Basic ${ADMIN_KEY}` });
    expect(res.status).toBe(401);
  });
});

describe("GET /v1/analytics/payments — schema", () => {
  test("admin auth + empty ledger → all 8 keys present, _partial:true", async () => {
    const env = makeEnv();
    const res = await fetchPayments(env, { Authorization: `Bearer ${ADMIN_KEY}` });
    expect(res.status).toBe(200);
    const body = (await res.json()) as AnalyticsPaymentsBody;

    // All 8 contract fields exist with correct types
    expect(typeof body.platform_cut_usd_24h).toBe("string");
    expect(typeof body.platform_cut_usd_30d).toBe("string");
    expect(typeof body.sponsor_settled_usd_24h).toBe("string");
    expect(typeof body.sponsor_recouped_usd_24h).toBe("string");
    expect(typeof body.creator_payouts_usd_24h).toBe("string");
    expect(typeof body.flex_escrows_active).toBe("number");
    expect(typeof body.flex_pending_settlements).toBe("number");
    expect(typeof body.flex_holds_in_memory).toBe("number");

    // Empty ledger → sponsor totals are "0.00"
    expect(body.sponsor_settled_usd_24h).toBe("0.00");
    expect(body.sponsor_recouped_usd_24h).toBe("0.00");

    // Honest-about-coverage flag (contract b21e7d7e: platform_cut +
    // creator_payouts are now real reads off the settlement ledger; the only
    // remaining TODO fields are the external facilitator-snapshot fields).
    expect(body._partial).toBe(true);
    expect(Array.isArray(body._instrumented_fields)).toBe(true);
    expect(body._instrumented_fields).toContain("sponsor_settled_usd_24h");
    expect(body._instrumented_fields).toContain("sponsor_recouped_usd_24h");
    // contract b21e7d7e: these three are now derived from the real ledger.
    expect(body._instrumented_fields).toContain("platform_cut_usd_24h");
    expect(body._instrumented_fields).toContain("platform_cut_usd_30d");
    expect(body._instrumented_fields).toContain("creator_payouts_usd_24h");
    // Facilitator-snapshot fields are still not-yet-instrumented.
    expect(body._instrumented_fields).not.toContain("flex_escrows_active");
    expect(body._instrumented_fields).not.toContain("flex_pending_settlements");
    expect(body._instrumented_fields).not.toContain("flex_holds_in_memory");
  });
});

describe("GET /v1/analytics/payments — sponsor settled aggregation", () => {
  test("3 ledger rows of $1 each within 24h → sponsor_settled_usd_24h = '3.00'", async () => {
    const nowIso = new Date().toISOString();
    seedLedgerRow({ ledger_id: "spr-aa", amount_uc: 1_000_000, settled_at: nowIso });
    seedLedgerRow({ ledger_id: "spr-bb", amount_uc: 1_000_000, settled_at: nowIso });
    seedLedgerRow({ ledger_id: "spr-cc", amount_uc: 1_000_000, settled_at: nowIso });

    const env = makeEnv();
    const res = await fetchPayments(env, { Authorization: `Bearer ${ADMIN_KEY}` });
    expect(res.status).toBe(200);
    const body = (await res.json()) as AnalyticsPaymentsBody;
    expect(body.sponsor_settled_usd_24h).toBe("3.00");
  });

  test("rows older than 24h are excluded from _24h fields", async () => {
    const now = Date.now();
    const tooOld = new Date(now - 48 * 60 * 60 * 1000).toISOString(); // 48h ago
    const recent = new Date(now - 60 * 60 * 1000).toISOString(); // 1h ago

    seedLedgerRow({ ledger_id: "spr-old", amount_uc: 5_000_000, settled_at: tooOld });
    seedLedgerRow({ ledger_id: "spr-new", amount_uc: 2_000_000, settled_at: recent });

    const env = makeEnv();
    const res = await fetchPayments(env, { Authorization: `Bearer ${ADMIN_KEY}` });
    const body = (await res.json()) as AnalyticsPaymentsBody;
    // Only the $2 recent row counts
    expect(body.sponsor_settled_usd_24h).toBe("2.00");
  });

  test("malformed amount_uc on a row doesn't break the aggregator", async () => {
    const nowIso = new Date().toISOString();
    seedLedgerRow({ ledger_id: "spr-good", amount_uc: 1_000_000, settled_at: nowIso });
    // Write a row with a non-numeric amount_uc directly to KV.
    const kv = new LocalKV("stats");
    await kv.put(
      "sponsor:ledger:spr-bad",
      JSON.stringify({
        ledger_id: "spr-bad",
        kind: "sponsor",
        agent_id: "agent-X",
        skill_id: "skill-Y",
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        amount_uc: "not-a-number" as any,
        creator_wallet: "So1",
        settled_tx: "0x",
        settled_at: nowIso,
      }),
    );

    const env = makeEnv();
    const res = await fetchPayments(env, { Authorization: `Bearer ${ADMIN_KEY}` });
    expect(res.status).toBe(200);
    const body = (await res.json()) as AnalyticsPaymentsBody;
    // Bad row contributes 0; good row contributes $1
    expect(body.sponsor_settled_usd_24h).toBe("1.00");
  });
});

describe("GET /v1/analytics/payments — Flex-rail recoup (10%)", () => {
  test("Flex-rail sponsor row → 10% recouped", async () => {
    const nowIso = new Date().toISOString();
    seedLedgerRow({
      ledger_id: "spr-flex-1",
      amount_uc: 10_000_000, // $10
      settled_at: nowIso,
      payment_method: "flex",
    });

    const env = makeEnv();
    const res = await fetchPayments(env, { Authorization: `Bearer ${ADMIN_KEY}` });
    const body = (await res.json()) as AnalyticsPaymentsBody;
    expect(body.sponsor_settled_usd_24h).toBe("10.00");
    // 10% of $10 = $1.00
    expect(body.sponsor_recouped_usd_24h).toBe("1.00");
  });

  test("non-Flex rows (no payment_method) do NOT contribute to recouped", async () => {
    const nowIso = new Date().toISOString();
    // Legacy direct-pay row (no payment_method, the v6.15.0 shape)
    seedLedgerRow({
      ledger_id: "spr-legacy",
      amount_uc: 10_000_000,
      settled_at: nowIso,
    });
    // Explicitly direct-tagged row
    seedLedgerRow({
      ledger_id: "spr-direct",
      amount_uc: 5_000_000,
      settled_at: nowIso,
      payment_method: "direct_spl",
    });

    const env = makeEnv();
    const res = await fetchPayments(env, { Authorization: `Bearer ${ADMIN_KEY}` });
    const body = (await res.json()) as AnalyticsPaymentsBody;
    expect(body.sponsor_settled_usd_24h).toBe("15.00");
    // Neither row is Flex-rail → 0 recoup
    expect(body.sponsor_recouped_usd_24h).toBe("0.00");
  });

  test("mixed rail: only Flex rows contribute to recouped", async () => {
    const nowIso = new Date().toISOString();
    seedLedgerRow({
      ledger_id: "spr-mix-flex",
      amount_uc: 20_000_000, // $20 flex → $2 recoup
      settled_at: nowIso,
      payment_method: "flex",
    });
    seedLedgerRow({
      ledger_id: "spr-mix-direct",
      amount_uc: 30_000_000, // $30 direct → no recoup
      settled_at: nowIso,
      payment_method: "direct_spl",
    });

    const env = makeEnv();
    const res = await fetchPayments(env, { Authorization: `Bearer ${ADMIN_KEY}` });
    const body = (await res.json()) as AnalyticsPaymentsBody;
    expect(body.sponsor_settled_usd_24h).toBe("50.00");
    expect(body.sponsor_recouped_usd_24h).toBe("2.00");
  });

  test("Flex row older than 24h does NOT contribute to recouped_24h", async () => {
    const tooOld = new Date(Date.now() - 48 * 60 * 60 * 1000).toISOString();
    seedLedgerRow({
      ledger_id: "spr-old-flex",
      amount_uc: 10_000_000,
      settled_at: tooOld,
      payment_method: "flex",
    });

    const env = makeEnv();
    const res = await fetchPayments(env, { Authorization: `Bearer ${ADMIN_KEY}` });
    const body = (await res.json()) as AnalyticsPaymentsBody;
    expect(body.sponsor_settled_usd_24h).toBe("0.00");
    expect(body.sponsor_recouped_usd_24h).toBe("0.00");
  });
});
