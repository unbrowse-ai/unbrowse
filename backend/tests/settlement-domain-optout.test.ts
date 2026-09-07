/**
 * Domain-opt-out end-to-end pin (contract b21e7d7e).
 *
 * Two domains:
 *   - Domain A — verified, owner_compensation_opt_in=true,
 *                owner_wallet_usdc_ata set (the post-claim manifest shape).
 *                Expected: aggregated settlement carves OWNER_BPS (1500 = 15%)
 *                to the owner ATA.
 *   - Domain B — opted out via DomainTakedownRecord at `domain-optout:<domain>`
 *                AND a manifest that would otherwise carve OWNER_BPS. Expected:
 *                owner lane is ZERO, the freed bps roll into the contributor +
 *                platform pool.
 *
 * The test seeds both manifests + matching sponsor-ledger rows, then calls
 * `POST /v1/admin/aggregate-settlement?dry_run=1` and inspects the persisted
 * batch's recipients. No mocks of the route, KV, or aggregator.
 */

import { beforeEach, describe, expect, test } from "bun:test";
import { app } from "../src/index.js";
import type { Env, SkillManifest } from "../src/types.js";
import { LocalKV, clearKVCacheForTests } from "../src/services/kv.js";
import type { SponsorLedgerRow } from "../src/middleware/sponsor.js";
import {
  buildOptOutKey,
  type DomainTakedownRecord,
} from "../src/services/domain-claim.js";

const ADMIN_KEY = "test-admin-secret-key";
const PLATFORM_USDC_ATA = "Pp1atfomUsdcATA111111111111111111111111111";

// Two distinct owner ATAs so we can prove the owner lane lands on the right
// recipient (or doesn't land at all when opted out).
const OWNER_ATA_A = "OwnerAtaAaaa1111111111111111111111111111111";
const OWNER_ATA_B = "OwnerAtaBbbb2222222222222222222222222222222";

// A shared contributor ATA so every skill carries a payable contributor
// (otherwise computeFlexSplits returns [] and the platform takes 100%, which
// makes the opt-out impossible to distinguish from a "no contributors" skill).
const CONTRIB_ATA = "Contr1butorAta3333333333333333333333333333";

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
    ADMIN_KEY,
    FLEX_PLATFORM_RECIPIENT_USDC_ATA: PLATFORM_USDC_ATA,
  };
}

function makeReq(path: string, init: RequestInit = {}): Request {
  return new Request(`http://local.test${path}`, {
    ...init,
    method: init.method ?? "GET",
    headers: { Authorization: `Bearer ${ADMIN_KEY}`, ...(init.headers ?? {}) },
  });
}

function seedSkill(
  skillId: string,
  domain: string,
  opts: { ownerOptIn: boolean; ownerAta?: string },
): SkillManifest {
  const manifest: SkillManifest = {
    skill_id: skillId,
    version: "1.0.0",
    schema_version: "1",
    name: domain,
    intent_signature: domain,
    domain,
    description: "fixture",
    owner_type: "marketplace",
    execution_type: "http",
    lifecycle: "active",
    created_at: "2026-05-23T00:00:00.000Z",
    updated_at: "2026-05-23T00:00:00.000Z",
    endpoints: [],
    contributors: [
      {
        agent_id: "agent-contrib-1",
        wallet_address: CONTRIB_ATA,
        endpoints_contributed: 3,
        cumulative_delta: 3,
        share: 100,
        first_contributed_at: "2026-05-22T00:00:00.000Z",
        last_contributed_at: "2026-05-22T00:00:00.000Z",
      },
    ],
    owner_compensation_opt_in: opts.ownerOptIn,
    ...(opts.ownerAta
      ? {
          owner_wallet_usdc_ata: opts.ownerAta,
          owner_wallet_address: opts.ownerAta,
          owner_wallet_verified_at: "2026-05-22T00:00:00.000Z",
        }
      : {}),
  };
  const kv = new LocalKV("skills-v2");
  void kv.put(`skill:${skillId}`, JSON.stringify(manifest));
  return manifest;
}

function seedOptOut(domain: string): void {
  const record: DomainTakedownRecord = {
    domain,
    verified_at: "2026-05-22T00:00:00.000Z",
    verified_by_agent_id: "agent-owner-B",
    txt_value_witness: "unbrowse-takedown=chal123",
    doh_attestations: [{ provider: "cloudflare", observed_at: "2026-05-22T00:00:00.000Z" }],
    schema_version: 1,
  };
  const kv = new LocalKV("stats");
  void kv.put(buildOptOutKey(domain), JSON.stringify(record));
}

function seedLedgerRow(row: Partial<SponsorLedgerRow> & { ledger_id: string }): void {
  const full = {
    ledger_id: row.ledger_id,
    kind: "sponsor" as const,
    agent_id: row.agent_id ?? "agent-X",
    skill_id: row.skill_id ?? "skill-test",
    amount_uc: row.amount_uc ?? 1_000_000,
    creator_wallet: row.creator_wallet ?? "So1Creator99999999999999999999999999",
    settled_tx: row.settled_tx ?? "0xtx-abcdef",
    settled_at: row.settled_at ?? "2026-05-23T12:00:00.000Z",
  };
  const kv = new LocalKV("stats");
  void kv.put(`sponsor:ledger:${full.ledger_id}`, JSON.stringify(full));
}

beforeEach(() => {
  clearKVCacheForTests("stats");
  clearKVCacheForTests("skills-v2");
});

interface BatchResponse {
  batch: {
    id: string;
    batch_size: number;
    total_amount_uc: number;
    recipients: Array<{
      wallet: string;
      amount_uc: number;
      count: number;
      owner_lane?: boolean;
    }>;
    source_ledger_ids: string[];
    status: string;
  };
  dry_run: boolean;
}

describe("aggregate-settlement — domain opt-out propagation", () => {
  test("domain A (verified, opted IN) — owner ATA receives 1500 bps; domain B (opt-out) — owner lane zeroed", async () => {
    // Domain A — verified, owner opted in. Owner ATA = OWNER_ATA_A.
    seedSkill("skill-A", "example-a.com", {
      ownerOptIn: true,
      ownerAta: OWNER_ATA_A,
    });
    // Domain B — manifest looks identical EXCEPT we'll write the takedown
    // record at `domain-optout:example-b.com`. The aggregator must read that
    // key and coerce owner_compensation_opt_in to false at compute time.
    seedSkill("skill-B", "example-b.com", {
      ownerOptIn: true,
      ownerAta: OWNER_ATA_B,
    });
    seedOptOut("example-b.com");

    // 10M µ¢ ($10) on each domain → easy bps arithmetic.
    seedLedgerRow({
      ledger_id: "spr-A-1",
      skill_id: "skill-A",
      amount_uc: 10_000_000,
      creator_wallet: "WalletA",
    });
    seedLedgerRow({
      ledger_id: "spr-B-1",
      skill_id: "skill-B",
      amount_uc: 10_000_000,
      creator_wallet: "WalletB",
    });

    const env = makeEnv();
    const res = await app.fetch(
      makeReq("/v1/admin/aggregate-settlement?dry_run=1", { method: "POST" }),
      env,
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as BatchResponse;
    expect(body.batch.status).toBe("pending");
    expect(body.batch.batch_size).toBe(2);
    expect(body.batch.total_amount_uc).toBe(20_000_000);
    expect(body.dry_run).toBe(true);

    const byWallet = new Map(body.batch.recipients.map((r) => [r.wallet, r]));

    // Domain A: 1500 bps to OWNER_ATA_A out of 10M µ¢ = 1_500_000 µ¢.
    const aOwner = byWallet.get(OWNER_ATA_A);
    expect(aOwner).toBeDefined();
    expect(aOwner!.owner_lane).toBe(true);
    expect(aOwner!.amount_uc).toBe(1_500_000);

    // Domain B: OWNER_ATA_B MUST NOT be a recipient (owner lane zeroed).
    expect(byWallet.has(OWNER_ATA_B)).toBe(false);

    // Platform recipient should be present. The platform draws PLATFORM_BPS
    // (5000) from both domains = 5_000_000 µ¢ each = 10_000_000 µ¢ total.
    const platform = byWallet.get(PLATFORM_USDC_ATA);
    expect(platform).toBeDefined();
    expect(platform!.amount_uc).toBe(10_000_000);
    // owner_lane never sticks to the platform.
    expect(platform!.owner_lane).toBeFalsy();

    // Contributor receives:
    //   - Domain A: 10000 - 5000 (platform) - 1500 (owner) = 3500 bps = 3_500_000 µ¢
    //   - Domain B: 10000 - 5000 (platform)               = 5000 bps = 5_000_000 µ¢
    // Same ATA → 8_500_000 µ¢ total, count=2.
    const contrib = byWallet.get(CONTRIB_ATA);
    expect(contrib).toBeDefined();
    expect(contrib!.amount_uc).toBe(8_500_000);
    expect(contrib!.count).toBe(2);
    expect(contrib!.owner_lane).toBeFalsy();

    // bps coverage check: platform + ownerA + contrib = 10_000_000 + 1_500_000 + 8_500_000 = 20_000_000 µ¢.
    const total = body.batch.recipients.reduce((s, r) => s + r.amount_uc, 0);
    expect(total).toBe(20_000_000);

    // Source ledger ids carry both rows.
    expect(new Set(body.batch.source_ledger_ids)).toEqual(
      new Set(["spr-A-1", "spr-B-1"]),
    );
  });

  test("domain B alone (opted out) — no owner lane recipient even when ATA is set on manifest", async () => {
    // Sanity check that flips the domain A vs B logic: with ONLY the opted-
    // out domain, the only recipients are platform + contributor.
    seedSkill("skill-B-only", "opted-out.example", {
      ownerOptIn: true,
      ownerAta: OWNER_ATA_B,
    });
    seedOptOut("opted-out.example");

    seedLedgerRow({
      ledger_id: "spr-B-only-1",
      skill_id: "skill-B-only",
      amount_uc: 4_000_000,
    });

    const env = makeEnv();
    const res = await app.fetch(
      makeReq("/v1/admin/aggregate-settlement?dry_run=1", { method: "POST" }),
      env,
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as BatchResponse;
    expect(body.batch.batch_size).toBe(1);

    const wallets = body.batch.recipients.map((r) => r.wallet);
    expect(wallets).toContain(PLATFORM_USDC_ATA);
    expect(wallets).toContain(CONTRIB_ATA);
    expect(wallets).not.toContain(OWNER_ATA_B);
    expect(body.batch.recipients.every((r) => r.owner_lane !== true)).toBe(true);
  });

  test("aggregate-settlement persists the pending batch so GET /admin/settlement/:id finds it", async () => {
    seedSkill("skill-persist", "persist.example", { ownerOptIn: false });
    seedLedgerRow({
      ledger_id: "spr-persist-1",
      skill_id: "skill-persist",
      amount_uc: 2_000_000,
    });

    const env = makeEnv();
    const aggRes = await app.fetch(
      makeReq("/v1/admin/aggregate-settlement", { method: "POST" }),
      env,
    );
    expect(aggRes.status).toBe(200);
    const aggBody = (await aggRes.json()) as BatchResponse;
    const batchId = aggBody.batch.id;
    expect(batchId).toMatch(/^batch-/);

    const getRes = await app.fetch(
      makeReq(`/v1/admin/settlement/${batchId}`),
      env,
    );
    expect(getRes.status).toBe(200);
    const getBody = (await getRes.json()) as { batch: BatchResponse["batch"] };
    expect(getBody.batch.id).toBe(batchId);
    expect(getBody.batch.batch_size).toBe(1);
    expect(getBody.batch.total_amount_uc).toBe(2_000_000);

    const notFoundRes = await app.fetch(
      makeReq("/v1/admin/settlement/batch-does-not-exist"),
      env,
    );
    expect(notFoundRes.status).toBe(404);
  });
});

describe("aggregate-settlement — auth", () => {
  test("missing Authorization → 401", async () => {
    const env = makeEnv();
    const res = await app.fetch(
      new Request("http://local.test/v1/admin/aggregate-settlement", { method: "POST" }),
      env,
    );
    expect(res.status).toBe(401);
  });

  test("execute-settlement without batch_id → 400", async () => {
    const env = makeEnv();
    const res = await app.fetch(
      makeReq("/v1/admin/execute-settlement", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({}),
      }),
      env,
    );
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe("batch_id_required");
  });
});
