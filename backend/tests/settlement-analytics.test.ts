/**
 * Settlement-analytics pin (contract b21e7d7e).
 *
 * Seeds settled sponsor:ledger rows across 24h + 30d windows, then asserts
 * the live `GET /v1/analytics/payments` endpoint returns real, math-correct
 * platform_cut + creator_payouts values. `_partial` stays true because the
 * facilitator-snapshot fields are still TODO.
 *
 * No mocks — the test uses LocalKV through `app.fetch`, exactly like
 * analytics-payments.test.ts.
 */

import { beforeEach, describe, expect, test } from "bun:test";
import { app } from "../src/index.js";
import type { Env } from "../src/types.js";
import { LocalKV, clearKVCacheForTests } from "../src/services/kv.js";
import type { SponsorLedgerRow } from "../src/middleware/sponsor.js";

const ADMIN_KEY = "test-admin-secret-key";

function makeEnv(): Env {
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
    ADMIN_KEY,
  };
}

function seedLedgerRow(row: Partial<SponsorLedgerRow> & {
  ledger_id: string;
  effective_platform_bps?: number;
}): void {
  const full = {
    ledger_id: row.ledger_id,
    kind: "sponsor" as const,
    agent_id: row.agent_id ?? "agent-X",
    skill_id: row.skill_id ?? "skill-test",
    amount_uc: row.amount_uc ?? 1_000_000,
    creator_wallet: row.creator_wallet ?? "So1Creator99999999999999999999999999",
    settled_tx: row.settled_tx ?? "0xtx-abcdef",
    settled_at: row.settled_at ?? new Date().toISOString(),
    ...(row.payment_method !== undefined ? { payment_method: row.payment_method } : {}),
    ...(row.effective_platform_bps !== undefined
      ? { effective_platform_bps: row.effective_platform_bps }
      : {}),
  };
  const kv = new LocalKV("stats");
  void kv.put(`sponsor:ledger:${full.ledger_id}`, JSON.stringify(full));
}

beforeEach(() => {
  clearKVCacheForTests("stats");
});

interface PaymentsBody {
  platform_cut_usd_24h: string;
  platform_cut_usd_30d: string;
  sponsor_settled_usd_24h: string;
  sponsor_recouped_usd_24h: string;
  creator_payouts_usd_24h: string;
  _partial: boolean;
  _instrumented_fields: string[];
}

async function fetchPayments(env: Env): Promise<PaymentsBody> {
  const res = await app.fetch(
    new Request("http://local.test/v1/analytics/payments", {
      headers: { Authorization: `Bearer ${ADMIN_KEY}` },
    }),
    env,
  );
  expect(res.status).toBe(200);
  return (await res.json()) as PaymentsBody;
}

describe("GET /v1/analytics/payments — real platform_cut + creator_payouts (contract b21e7d7e)", () => {
  test("24h: 10 rows × $1 each → platform_cut 50% = $5; creator_payouts 50% = $5", async () => {
    const nowIso = new Date().toISOString();
    for (let i = 0; i < 10; i++) {
      seedLedgerRow({
        ledger_id: `spr-24h-${i}`,
        amount_uc: 1_000_000,
        settled_at: nowIso,
      });
    }
    const env = makeEnv();
    const body = await fetchPayments(env);

    expect(body.sponsor_settled_usd_24h).toBe("10.00");
    // Default PLATFORM_BPS = 5000 (50%). 10 × 1M × 0.5 = 5M µ¢ = $5.00.
    expect(body.platform_cut_usd_24h).toBe("5.00");
    // creator_payouts = settled - platform_cut.
    expect(body.creator_payouts_usd_24h).toBe("5.00");
  });

  test("30d window includes older rows that 24h excludes", async () => {
    const now = Date.now();
    const recent = new Date(now - 60 * 60 * 1000).toISOString(); // 1h ago
    const olderIn30d = new Date(now - 10 * 24 * 60 * 60 * 1000).toISOString(); // 10d ago
    const tooOld = new Date(now - 60 * 24 * 60 * 60 * 1000).toISOString(); // 60d ago

    seedLedgerRow({ ledger_id: "spr-recent", amount_uc: 2_000_000, settled_at: recent });
    seedLedgerRow({ ledger_id: "spr-10d", amount_uc: 4_000_000, settled_at: olderIn30d });
    seedLedgerRow({ ledger_id: "spr-60d", amount_uc: 100_000_000, settled_at: tooOld });

    const env = makeEnv();
    const body = await fetchPayments(env);

    // 24h only sees the $2 recent row → 50% platform = $1
    expect(body.sponsor_settled_usd_24h).toBe("2.00");
    expect(body.platform_cut_usd_24h).toBe("1.00");
    expect(body.creator_payouts_usd_24h).toBe("1.00");

    // 30d sees recent + 10d ago = $6 → 50% = $3
    expect(body.platform_cut_usd_30d).toBe("3.00");
  });

  test("row with effective_platform_bps override takes precedence over the 5000 default", async () => {
    const nowIso = new Date().toISOString();
    // $10 at 80% platform bps → $8 cut, $2 to creator.
    seedLedgerRow({
      ledger_id: "spr-override-1",
      amount_uc: 10_000_000,
      settled_at: nowIso,
      effective_platform_bps: 8000,
    });
    const env = makeEnv();
    const body = await fetchPayments(env);

    expect(body.sponsor_settled_usd_24h).toBe("10.00");
    expect(body.platform_cut_usd_24h).toBe("8.00");
    expect(body.creator_payouts_usd_24h).toBe("2.00");
  });

  test("_partial reflects only the facilitator-snapshot gap", async () => {
    const env = makeEnv();
    const body = await fetchPayments(env);
    expect(body._partial).toBe(true);
    expect(body._instrumented_fields).toContain("platform_cut_usd_24h");
    expect(body._instrumented_fields).toContain("platform_cut_usd_30d");
    expect(body._instrumented_fields).toContain("creator_payouts_usd_24h");
    expect(body._instrumented_fields).not.toContain("flex_escrows_active");
    expect(body._instrumented_fields).not.toContain("flex_pending_settlements");
    expect(body._instrumented_fields).not.toContain("flex_holds_in_memory");
  });

  test("empty ledger → zeros across the board, schema still valid", async () => {
    const env = makeEnv();
    const body = await fetchPayments(env);
    expect(body.platform_cut_usd_24h).toBe("0.00");
    expect(body.platform_cut_usd_30d).toBe("0.00");
    expect(body.creator_payouts_usd_24h).toBe("0.00");
    expect(body.sponsor_settled_usd_24h).toBe("0.00");
  });
});
