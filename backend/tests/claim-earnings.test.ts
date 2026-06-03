/**
 * GET /v1/claim/earnings?domain=<apex> — a bound website owner reads what their
 * wallet has been paid.
 *
 * Websites do not "redeem" tokens: the 15% owner lane (OWNER_BPS) is paid
 * directly to the owner's USDC ATA on-chain at settlement (flex.ts +
 * settlement.ts sendSponsorFlexPayment). This endpoint is the missing
 * *visibility* surface — it sums the owner-lane recipient amounts across the
 * persisted `settlement:ledger:*` batches for the wallet bound to the domain.
 *
 * No mocks — LocalKV through app.fetch, exactly like settlement-analytics.test.ts.
 */

import { beforeEach, describe, expect, test } from "bun:test";
import { app } from "../src/index.js";
import type { Env } from "../src/types.js";
import { LocalKV, clearKVCacheForTests } from "../src/services/kv.js";
import type { SettlementBatch } from "../src/services/settlement.js";
import type { DomainClaimBinding } from "../src/services/domain-claim.js";

const OWNER_ATA = "So1Owner11111111111111111111111111111111111";
const PLATFORM_ATA = "So1Platform1111111111111111111111111111111";

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
    ADMIN_KEY: "test-admin-secret-key",
  };
}

function seedBinding(domain: string): void {
  const binding: DomainClaimBinding = {
    domain,
    wallet_address: "So1OwnerWallet11111111111111111111111111111",
    wallet_usdc_ata: OWNER_ATA,
    verified_at: "2026-06-01T00:00:00.000Z",
    verified_by_agent_id: "agent-owner",
    txt_value_witness: "unbrowse-claim=deadbeef;wallet=So1OwnerWallet",
    doh_attestations: [{ provider: "cloudflare", observed_at: "2026-06-01T00:00:00.000Z" }],
    schema_version: 1,
  };
  void new LocalKV("stats").put(`domain-wallet:${domain}`, JSON.stringify(binding));
}

function seedBatch(b: SettlementBatch): void {
  void new LocalKV("stats").put(`settlement:ledger:${b.id}`, JSON.stringify(b));
}

async function getEarnings(env: Env, domain: string): Promise<Response> {
  return app.fetch(
    new Request(`http://local.test/v1/claim/earnings?domain=${encodeURIComponent(domain)}`),
    env,
  );
}

beforeEach(() => {
  clearKVCacheForTests("stats");
});

describe("GET /v1/claim/earnings — owner-lane payout visibility", () => {
  test("unbound domain → verified:false, zero earned", async () => {
    const res = await getEarnings(makeEnv(), "notbound.com");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { verified: boolean; earned_uc: number };
    expect(body.verified).toBe(false);
    expect(body.earned_uc).toBe(0);
  });

  test("invalid domain → 400", async () => {
    const res = await getEarnings(makeEnv(), "not a domain");
    expect(res.status).toBe(400);
  });

  test("sums executed owner-lane payouts, ignores pending + non-owner recipients", async () => {
    seedBinding("example.com");
    // Executed batch 1: owner paid 150_000 µ¢ ($0.15) alongside platform.
    seedBatch({
      id: "batch-A",
      batch_size: 1,
      total_amount_uc: 1_000_000,
      recipients: [
        { wallet: PLATFORM_ATA, amount_uc: 500_000, count: 1 },
        { wallet: OWNER_ATA, amount_uc: 150_000, count: 1, owner_lane: true },
      ],
      source_ledger_ids: ["spr-1"],
      created_at: 1_000,
      executed_at: 2_000,
      tx_signature: "sigA",
      status: "executed",
    });
    // Executed batch 2: owner paid 300_000 µ¢ ($0.30), later — last_tx should be sigB.
    seedBatch({
      id: "batch-B",
      batch_size: 1,
      total_amount_uc: 2_000_000,
      recipients: [{ wallet: OWNER_ATA, amount_uc: 300_000, count: 2, owner_lane: true }],
      source_ledger_ids: ["spr-2"],
      created_at: 3_000,
      executed_at: 4_000,
      tx_signature: "sigB",
      status: "executed",
    });
    // Pending batch: NOT yet on-chain → counts as pending, not earned.
    seedBatch({
      id: "batch-C",
      batch_size: 1,
      total_amount_uc: 100_000,
      recipients: [{ wallet: OWNER_ATA, amount_uc: 99_999, count: 1, owner_lane: true }],
      source_ledger_ids: ["spr-3"],
      created_at: 5_000,
      status: "pending",
    });
    // Batch where the owner is not a recipient → ignored entirely.
    seedBatch({
      id: "batch-D",
      batch_size: 1,
      total_amount_uc: 500_000,
      recipients: [{ wallet: PLATFORM_ATA, amount_uc: 500_000, count: 1 }],
      source_ledger_ids: ["spr-4"],
      created_at: 6_000,
      executed_at: 7_000,
      tx_signature: "sigD",
      status: "executed",
    });

    const res = await getEarnings(makeEnv(), "example.com");
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      verified: boolean;
      domain: string;
      owner_wallet_usdc_ata: string;
      earned_uc: number;
      earned_usd: string;
      pending_uc: number;
      payout_count: number;
      last_tx: string | null;
    };
    expect(body.verified).toBe(true);
    expect(body.domain).toBe("example.com");
    expect(body.owner_wallet_usdc_ata).toBe(OWNER_ATA);
    // 150_000 + 300_000 = 450_000 µ¢ = $0.45 across 2 executed payouts.
    expect(body.earned_uc).toBe(450_000);
    expect(body.earned_usd).toBe("0.45");
    expect(body.payout_count).toBe(2);
    // Pending batch is reported separately, not in earned.
    expect(body.pending_uc).toBe(99_999);
    // Latest executed batch wins last_tx.
    expect(body.last_tx).toBe("sigB");
  });
});
