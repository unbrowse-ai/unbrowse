/**
 * Settlement aggregation unit tests (contract b21e7d7e).
 *
 * Exercises `aggregateUnsettled` against the in-process LocalKV. No mocks of
 * the unit under test — we seed real `sponsor:ledger:*` rows + (when needed)
 * a real `skill:*` manifest entry, then assert that the aggregator filters,
 * groups, and totals correctly.
 *
 * Honest scope: this file proves the aggregation primitive itself. The
 * domain-opt-out behaviour is exercised end-to-end in
 * `settlement-domain-optout.test.ts` against the admin route.
 */

import { beforeEach, describe, expect, test } from "bun:test";
import type { Env } from "../src/types.js";
import { LocalKV, clearKVCacheForTests } from "../src/services/kv.js";
import type { SponsorLedgerRow } from "../src/middleware/sponsor.js";
import { aggregateUnsettled } from "../src/services/settlement.js";

const PLATFORM_USDC_ATA = "Pp1atfomUsdcATA111111111111111111111111111";

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
    FLEX_PLATFORM_RECIPIENT_USDC_ATA: PLATFORM_USDC_ATA,
  };
}

function seedLedgerRow(row: Partial<SponsorLedgerRow> & {
  ledger_id: string;
  batch_settled_tx?: string;
}): void {
  const full = {
    ledger_id: row.ledger_id,
    kind: "sponsor" as const,
    agent_id: row.agent_id ?? "agent-X",
    skill_id: row.skill_id ?? "skill-test",
    amount_uc: row.amount_uc ?? 1_000_000,
    creator_wallet: row.creator_wallet ?? "So1Creator99999999999999999999999999",
    settled_tx: row.settled_tx ?? "0xtx-abcdef",
    settled_at: row.settled_at ?? "2026-05-14T12:00:00.000Z",
    ...(row.batch_settled_tx ? { batch_settled_tx: row.batch_settled_tx } : {}),
  };
  const kv = new LocalKV("stats");
  void kv.put(`sponsor:ledger:${full.ledger_id}`, JSON.stringify(full));
}

beforeEach(() => {
  clearKVCacheForTests("stats");
  clearKVCacheForTests("skills-v2");
});

describe("aggregateUnsettled — filtering + grouping", () => {
  test("returns empty pending batch when no rows exist", async () => {
    const env = makeEnv();
    const batch = await aggregateUnsettled(env);
    expect(batch.status).toBe("pending");
    expect(batch.batch_size).toBe(0);
    expect(batch.total_amount_uc).toBe(0);
    expect(batch.recipients).toEqual([]);
    expect(batch.source_ledger_ids).toEqual([]);
  });

  test("filters out rows already stamped with batch_settled_tx", async () => {
    seedLedgerRow({
      ledger_id: "spr-already-settled",
      amount_uc: 5_000_000,
      creator_wallet: "WalletA",
      batch_settled_tx: "0xtx-prior-batch",
    });
    seedLedgerRow({
      ledger_id: "spr-fresh",
      amount_uc: 1_000_000,
      creator_wallet: "WalletA",
    });
    const env = makeEnv();
    const batch = await aggregateUnsettled(env);
    expect(batch.batch_size).toBe(1);
    expect(batch.total_amount_uc).toBe(1_000_000);
    expect(batch.source_ledger_ids).toEqual(["spr-fresh"]);
  });

  test("groups two same-creator rows + one different-creator row correctly", async () => {
    // Three rows in different skill groups → no manifest lookup, fallback to
    // single-recipient-per-creator. This is the documented degraded path.
    seedLedgerRow({
      ledger_id: "spr-A1",
      skill_id: "skill-no-manifest-A",
      amount_uc: 3_000_000,
      creator_wallet: "WalletA",
    });
    seedLedgerRow({
      ledger_id: "spr-A2",
      skill_id: "skill-no-manifest-A",
      amount_uc: 2_000_000,
      creator_wallet: "WalletA",
    });
    seedLedgerRow({
      ledger_id: "spr-B1",
      skill_id: "skill-no-manifest-B",
      amount_uc: 1_000_000,
      creator_wallet: "WalletB",
    });

    const env = makeEnv();
    const batch = await aggregateUnsettled(env);
    expect(batch.batch_size).toBe(3);
    expect(batch.total_amount_uc).toBe(6_000_000);

    // Two recipients: WalletA (5M, count=2) and WalletB (1M, count=1).
    expect(batch.recipients).toHaveLength(2);
    const a = batch.recipients.find((r) => r.wallet === "WalletA");
    const b = batch.recipients.find((r) => r.wallet === "WalletB");
    expect(a).toBeDefined();
    expect(b).toBeDefined();
    expect(a!.amount_uc).toBe(5_000_000);
    expect(a!.count).toBe(2);
    expect(b!.amount_uc).toBe(1_000_000);
    expect(b!.count).toBe(1);

    // Ordering: largest amount first.
    expect(batch.recipients[0]!.amount_uc).toBeGreaterThanOrEqual(
      batch.recipients[1]!.amount_uc,
    );

    // Source ledger ids include all three.
    expect(batch.source_ledger_ids).toHaveLength(3);
    expect(new Set(batch.source_ledger_ids)).toEqual(
      new Set(["spr-A1", "spr-A2", "spr-B1"]),
    );
  });

  test("`since` / `until` window filter excludes out-of-range rows", async () => {
    const tStart = Date.parse("2026-05-14T00:00:00.000Z");
    const tMid = Date.parse("2026-05-14T12:00:00.000Z");
    const tEnd = Date.parse("2026-05-14T23:59:59.000Z");

    seedLedgerRow({
      ledger_id: "spr-too-early",
      settled_at: new Date(tStart - 60_000).toISOString(),
    });
    seedLedgerRow({
      ledger_id: "spr-in-window",
      settled_at: new Date(tMid).toISOString(),
    });
    seedLedgerRow({
      ledger_id: "spr-too-late",
      settled_at: new Date(tEnd + 60_000).toISOString(),
    });

    const env = makeEnv();
    const batch = await aggregateUnsettled(env, {
      since: tStart,
      until: tEnd,
    });
    expect(batch.batch_size).toBe(1);
    expect(batch.source_ledger_ids).toEqual(["spr-in-window"]);
  });

  test("corrupted JSON row is skipped, well-formed neighbour still aggregates", async () => {
    const kv = new LocalKV("stats");
    await kv.put("sponsor:ledger:spr-broken", "not-valid-json{");
    await kv.put(
      "sponsor:ledger:spr-wrong-kind",
      JSON.stringify({ kind: "other", ledger_id: "spr-wrong-kind" }),
    );
    seedLedgerRow({
      ledger_id: "spr-good",
      amount_uc: 4_000_000,
      creator_wallet: "WalletC",
    });

    const env = makeEnv();
    const batch = await aggregateUnsettled(env);
    expect(batch.batch_size).toBe(1);
    expect(batch.total_amount_uc).toBe(4_000_000);
    expect(batch.recipients).toHaveLength(1);
    expect(batch.recipients[0]!.wallet).toBe("WalletC");
  });

  test("rows with non-positive amount are kept in source_ledger_ids but contribute nothing to totals", async () => {
    seedLedgerRow({
      ledger_id: "spr-zero",
      skill_id: "skill-zero",
      amount_uc: 0,
      creator_wallet: "WalletZ",
    });
    const env = makeEnv();
    const batch = await aggregateUnsettled(env);
    expect(batch.batch_size).toBe(1);
    expect(batch.total_amount_uc).toBe(0);
    expect(batch.recipients).toEqual([]);
    // Source ids retain the row so it gets stamped on settlement (won't replay).
    expect(batch.source_ledger_ids).toEqual(["spr-zero"]);
  });
});
