/**
 * Dry-run execute proof (contract b21e7d7e).
 *
 * Seeds a small unsettled set, aggregates, then calls
 * `POST /v1/admin/execute-settlement` with `dry_run:true`. The response must
 * carry a valid FlexAuthorizationDraft (splits sum to exactly 10000 bps,
 * re-validated against `services/flex.ts`'s contract), and no Solana tx must
 * be submitted (no `tx_signature` populated).
 */

import { beforeEach, describe, expect, test } from "bun:test";
import { app } from "../src/index.js";
import type { Env, SkillManifest } from "../src/types.js";
import { LocalKV, clearKVCacheForTests } from "../src/services/kv.js";
import type { SponsorLedgerRow } from "../src/middleware/sponsor.js";

const ADMIN_KEY = "test-admin-secret-key";
const PLATFORM_USDC_ATA = "Pp1atfomUsdcATA111111111111111111111111111";
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
    // Pin mainnet so the authorization mint assertion below targets mainnet USDC
    // (the mint is network-driven via resolveFlexNetwork).
    X402_NETWORK_MODE: "mainnet",
    ADMIN_KEY,
    FLEX_PLATFORM_RECIPIENT_USDC_ATA: PLATFORM_USDC_ATA,
  };
}

function makeReq(path: string, init: RequestInit = {}): Request {
  return new Request(`http://local.test${path}`, {
    ...init,
    method: init.method ?? "GET",
    headers: {
      Authorization: `Bearer ${ADMIN_KEY}`,
      ...(init.headers ?? {}),
    },
  });
}

function seedSkill(skillId: string, domain: string): void {
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
        endpoints_contributed: 1,
        cumulative_delta: 1,
        share: 100,
        first_contributed_at: "2026-05-22T00:00:00.000Z",
        last_contributed_at: "2026-05-22T00:00:00.000Z",
      },
    ],
  };
  const kv = new LocalKV("skills-v2");
  void kv.put(`skill:${skillId}`, JSON.stringify(manifest));
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

interface AggregateResponse {
  batch: { id: string; recipients: Array<{ wallet: string; amount_uc: number }> };
  dry_run: boolean;
}

interface ExecuteResponse {
  batch: {
    id: string;
    status: string;
    tx_signature?: string;
    executed_at?: number;
  };
  authorization?: {
    escrow: string;
    mint: string;
    maxAmount: string;
    authorizationId: string;
    expiresAtSlot: string;
    splits: Array<{ recipient: string; bps: number }>;
  };
  projected_splits?: Array<{ recipient: string; bps: number }>;
  tx_signature?: string;
  dry_run: boolean;
}

describe("execute-settlement — dry_run", () => {
  test("returns FlexAuthorizationDraft with splits summing to 10000 bps; no tx submitted", async () => {
    seedSkill("skill-D", "dryrun.example");
    seedLedgerRow({
      ledger_id: "spr-D-1",
      skill_id: "skill-D",
      amount_uc: 7_500_000,
    });
    seedLedgerRow({
      ledger_id: "spr-D-2",
      skill_id: "skill-D",
      amount_uc: 2_500_000,
    });

    const env = makeEnv();

    // Step 1: aggregate to mint a batch id.
    const aggRes = await app.fetch(
      makeReq("/v1/admin/aggregate-settlement", { method: "POST" }),
      env,
    );
    expect(aggRes.status).toBe(200);
    const aggBody = (await aggRes.json()) as AggregateResponse;
    const batchId = aggBody.batch.id;

    // Step 2: execute with dry_run:true.
    const execRes = await app.fetch(
      makeReq("/v1/admin/execute-settlement", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ batch_id: batchId, dry_run: true }),
      }),
      env,
    );
    expect(execRes.status).toBe(200);
    const body = (await execRes.json()) as ExecuteResponse;

    expect(body.dry_run).toBe(true);
    // No Solana tx was submitted.
    expect(body.tx_signature).toBeUndefined();
    expect(body.batch.tx_signature).toBeUndefined();
    expect(body.batch.executed_at).toBeUndefined();
    expect(body.batch.status).toBe("pending");

    // Authorization draft is present.
    expect(body.authorization).toBeDefined();
    expect(body.authorization!.splits.length).toBeGreaterThan(0);

    // Splits sum to exactly 10000 bps (the buildFlexAuthorization contract).
    const total = body.authorization!.splits.reduce((s, x) => s + x.bps, 0);
    expect(total).toBe(10000);

    // projected_splits matches the authorization draft splits.
    expect(body.projected_splits).toBeDefined();
    expect(body.projected_splits!.length).toBe(body.authorization!.splits.length);

    // USDC mint is the canonical mainnet mint.
    expect(body.authorization!.mint).toBe("EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v");

    // maxAmount equals the batch total in µ¢ (7.5M + 2.5M = 10M).
    expect(body.authorization!.maxAmount).toBe("10000000");

    // After dry-run, the persisted batch row is still pending.
    const getRes = await app.fetch(
      makeReq(`/v1/admin/settlement/${batchId}`),
      env,
    );
    const getBody = (await getRes.json()) as { batch: { status: string } };
    expect(getBody.batch.status).toBe("pending");
  });

  test("execute-settlement on missing batch_id returns 404", async () => {
    const env = makeEnv();
    const res = await app.fetch(
      makeReq("/v1/admin/execute-settlement", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ batch_id: "no-such-batch", dry_run: true }),
      }),
      env,
    );
    expect(res.status).toBe(404);
  });
});
