/**
 * Settlement service (contract b21e7d7e) — marketplace settlement batches.
 *
 * Roll the unsettled sponsor:ledger:* rows into per-recipient aggregations,
 * persist them as a pending `settlement:ledger:<batch_id>` batch, then submit
 * the batch via a sponsor-on-Flex authorization. Dry-run returns the
 * authorization shape WITHOUT submitting.
 *
 * Pipeline
 * --------
 *   1. `aggregateUnsettled(env)` — walks `sponsor:ledger:*`, filters to rows
 *      where `batch_settled_tx` is undefined, groups by skill_id, looks up each
 *      skill manifest, derives owner/contributor/platform splits via
 *      `computeFlexSplits`, zeros the owner lane when a `domain-optout:<domain>`
 *      key is present in statsKV, and returns a SettlementBatch in
 *      `status:"pending"`. Persists NOTHING.
 *   2. `persistBatch(env, batch)` — writes `settlement:ledger:<batch.id>` to
 *      statsKV, idempotent on batch.id.
 *   3. `executeSettlement(env, batchId, {dry_run})` — reads the persisted
 *      batch, normalises the recipients into FlexSplit bps via `mergeSplits`,
 *      assembles a `FlexAuthorizationDraft` via `buildFlexAuthorization`. On
 *      dry-run, returns the draft + projected aggregations and exits without
 *      Solana RPC. On live, signs+submits via `sendSponsorFlexPayment` and
 *      stamps each source row with `batch_settled_tx + batch_settled_at`.
 *
 * Domain opt-out
 * --------------
 *   A verified domain owner can opt their domain OUT of compensation by
 *   publishing the takedown TXT record (see services/domain-claim.ts). When
 *   `domain-optout:<domain>` is present in statsKV the aggregation zeros the
 *   owner lane for any row whose skill manifest matches that domain — the
 *   owner_compensation_opt_in flag on the manifest is treated as false at
 *   compute time. Contributors + platform receive the freed bps.
 *
 * Type discipline
 * ---------------
 *   The persisted SponsorLedgerRow JSON receives two extra fields on
 *   `executeSettlement` stamp:
 *
 *     batch_settled_tx?: string   — Solana tx signature from sponsor-flex
 *     batch_settled_at?: string   — ISO timestamp of the stamp
 *
 *   These DO NOT live on the canonical `SponsorLedgerRow` interface (changing
 *   that type cascades through 20+ files); the settlement service reads + writes
 *   them as a structural extension. `aggregateUnsettled` treats absence of
 *   `batch_settled_tx` as "unsettled."
 */

import type { Env } from "../types.js";
import { statsKV } from "./kv.js";
import { getSkill } from "./marketplace.js";
import type { SponsorLedgerRow } from "../middleware/sponsor.js";
import {
  buildFlexAuthorization,
  computeFlexSplits,
  mergeSplits,
  type FlexAuthorizationDraft,
  type FlexSplit,
} from "./flex.js";
import { platformRecipientUsdcAta } from "./flex-facilitator.js";
import { sendSponsorFlexPayment } from "./sponsor-flex.js";
import { buildOptOutKey } from "./domain-claim.js";

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface SettlementRecipient {
  wallet: string;
  /** USDC micro-cents (1_000_000 = $1). */
  amount_uc: number;
  /** Number of source ledger rows whose splits contributed to this recipient. */
  count: number;
  /** True iff this recipient is the verified domain owner lane on its
   *  contributing skill (matches `owner_wallet_usdc_ata`). */
  owner_lane?: boolean;
}

export interface SettlementBatch {
  id: string;
  batch_size: number;
  total_amount_uc: number;
  recipients: SettlementRecipient[];
  source_ledger_ids: string[];
  created_at: number;
  executed_at?: number;
  tx_signature?: string;
  status: "pending" | "executed" | "failed";
  /** Set on `status:"failed"` to carry the operator-readable reason. */
  failure_reason?: string;
}

export interface AggregationFilter {
  /** Inclusive lower bound on row `settled_at` (unix ms). */
  since?: number;
  /** Exclusive upper bound on row `settled_at` (unix ms). */
  until?: number;
}

/** Structural extension to a stored sponsor row — readers MUST treat absence
 *  of `batch_settled_tx` as "this row has not been rolled up into a batch." */
export type SponsorLedgerRowWithBatch = SponsorLedgerRow & {
  batch_settled_tx?: string;
  batch_settled_at?: string;
};

// ---------------------------------------------------------------------------
// Internal: KV keys + helpers
// ---------------------------------------------------------------------------

const SPONSOR_LEDGER_PREFIX = "sponsor:ledger:";
const SETTLEMENT_LEDGER_PREFIX = "settlement:ledger:";

function settlementKey(batchId: string): string {
  return `${SETTLEMENT_LEDGER_PREFIX}${batchId}`;
}

function sponsorRowKey(ledgerId: string): string {
  return `${SPONSOR_LEDGER_PREFIX}${ledgerId}`;
}

/** Generate a batch id stable enough for KV ordering + idempotency. */
function mintBatchId(now: Date): string {
  const day = now.toISOString().slice(0, 10);
  // crypto.randomUUID is available on Workers + Bun.
  const suffix = crypto.randomUUID().slice(0, 8);
  return `batch-${day}-${suffix}`;
}

// ---------------------------------------------------------------------------
// Aggregation — pure read + group
// ---------------------------------------------------------------------------

/**
 * Walk every `sponsor:ledger:*` row, keep only those with no `batch_settled_tx`
 * (and excluded any rows whose `settled_at` falls outside the optional window),
 * group them by `skill_id`, look up the matching SkillManifest, compute the
 * per-skill splits (with domain opt-out applied), and aggregate into a
 * `SettlementBatch`-shape with `status:"pending"`. Persists nothing.
 */
export async function aggregateUnsettled(
  env: Env,
  filter: AggregationFilter = {},
): Promise<SettlementBatch> {
  const kv = statsKV(env);
  const entries = await kv.listWithValues(SPONSOR_LEDGER_PREFIX);

  // Parse + filter to unsettled rows in window.
  const unsettled: SponsorLedgerRowWithBatch[] = [];
  for (const entry of entries) {
    let parsed: SponsorLedgerRowWithBatch;
    try {
      parsed = JSON.parse(entry.value) as SponsorLedgerRowWithBatch;
    } catch {
      continue;
    }
    if (!parsed || parsed.kind !== "sponsor" || !parsed.ledger_id) continue;
    // batch_settled_tx absent → unsettled. Truthy → already rolled up.
    if (parsed.batch_settled_tx) continue;
    const settledMs = Date.parse(parsed.settled_at);
    if (!Number.isFinite(settledMs)) continue;
    if (filter.since !== undefined && settledMs < filter.since) continue;
    if (filter.until !== undefined && settledMs >= filter.until) continue;
    unsettled.push(parsed);
  }

  // Group rows by skill_id so we can resolve each manifest once.
  const bySkill = new Map<string, SponsorLedgerRowWithBatch[]>();
  for (const row of unsettled) {
    const list = bySkill.get(row.skill_id) ?? [];
    list.push(row);
    bySkill.set(row.skill_id, list);
  }

  // Per-recipient accumulator. owner_lane sticks to TRUE as soon as any
  // contributing row's skill marks this recipient as the owner lane.
  const accum = new Map<string, SettlementRecipient>();
  const sourceLedgerIds: string[] = [];
  let totalAmountUc = 0;

  // Pre-fetch the platform recipient ata. If env is mis-configured this
  // throws — surface it to the caller (admin route) as a clear 500.
  let platformAta: string;
  try {
    platformAta = platformRecipientUsdcAta(env);
  } catch (err) {
    // Without a platform recipient we cannot derive splits — return an empty
    // batch in the failed-precondition shape rather than throwing through
    // the admin route. The route shows the reason to the operator.
    return {
      id: mintBatchId(new Date()),
      batch_size: 0,
      total_amount_uc: 0,
      recipients: [],
      source_ledger_ids: unsettled.map((r) => r.ledger_id),
      created_at: Date.now(),
      status: "failed",
      failure_reason: `platform_recipient_not_configured: ${(err as Error).message}`,
    };
  }

  for (const [skillId, rows] of bySkill) {
    const totalUcForSkill = rows.reduce(
      (s, r) => s + (Number.isFinite(r.amount_uc) ? r.amount_uc : 0),
      0,
    );
    if (totalUcForSkill <= 0) {
      // Even rows with zero amount should still be marked as roll-up sources
      // so they don't replay on the next aggregate call.
      for (const r of rows) sourceLedgerIds.push(r.ledger_id);
      continue;
    }
    totalAmountUc += totalUcForSkill;
    for (const r of rows) sourceLedgerIds.push(r.ledger_id);

    // Look up the skill manifest. If the skill is gone, fall back to a
    // single-recipient settlement keyed on `creator_wallet`. This keeps a
    // settled-but-skill-deleted row settle-able.
    const manifest = await getSkill(env, skillId).catch(() => null);

    if (!manifest) {
      // Fallback: single recipient at the row's stored creator_wallet.
      // Group all rows into one entry. Note: `creator_wallet` on legacy rows
      // is the agent's settle target, not a USDC ATA — this is a degraded
      // path, but it keeps the batch closeable.
      for (const r of rows) {
        const wallet = r.creator_wallet?.trim() || "unknown";
        const prev = accum.get(wallet);
        if (prev) {
          prev.amount_uc += r.amount_uc;
          prev.count += 1;
        } else {
          accum.set(wallet, {
            wallet,
            amount_uc: r.amount_uc,
            count: 1,
          });
        }
      }
      continue;
    }

    // Apply domain opt-out: if `domain-optout:<domain>` is set in statsKV,
    // zero the owner lane by overriding owner_compensation_opt_in=false.
    let ownerOptIn = manifest.owner_compensation_opt_in === true;
    if (ownerOptIn && manifest.domain) {
      try {
        const optOutRaw = await kv.get(buildOptOutKey(manifest.domain));
        if (optOutRaw) ownerOptIn = false;
      } catch {
        // KV failure on the opt-out probe must not gate settlement — fall
        // through with the manifest's own opt-in flag.
      }
    }

    const skillForSplits = {
      contributors: manifest.contributors,
      owner_compensation_opt_in: ownerOptIn,
      owner_wallet_usdc_ata: manifest.owner_wallet_usdc_ata,
      markup_bps: manifest.markup_bps,
    };

    const splits = computeFlexSplits(skillForSplits, platformAta);

    // If the skill has no payable contributors AND no owner lane,
    // `computeFlexSplits` returns []. In that case route 100% to the platform.
    const effectiveSplits: FlexSplit[] = splits.length > 0
      ? splits
      : [{ recipient: platformAta, bps: 10000 }];

    const ownerAta = manifest.owner_wallet_usdc_ata?.trim();
    for (const split of effectiveSplits) {
      const shareUc = Math.floor((totalUcForSkill * split.bps) / 10000);
      if (shareUc <= 0) continue;
      const prev = accum.get(split.recipient);
      const isOwnerLane = ownerOptIn && !!ownerAta && split.recipient === ownerAta;
      if (prev) {
        prev.amount_uc += shareUc;
        prev.count += rows.length;
        if (isOwnerLane) prev.owner_lane = true;
      } else {
        accum.set(split.recipient, {
          wallet: split.recipient,
          amount_uc: shareUc,
          count: rows.length,
          ...(isOwnerLane ? { owner_lane: true } : {}),
        });
      }
    }
  }

  // Stable recipient ordering: by amount descending, then wallet ascending.
  const recipients = [...accum.values()].sort((a, b) => {
    if (b.amount_uc !== a.amount_uc) return b.amount_uc - a.amount_uc;
    return a.wallet.localeCompare(b.wallet);
  });

  return {
    id: mintBatchId(new Date()),
    batch_size: unsettled.length,
    total_amount_uc: totalAmountUc,
    recipients,
    source_ledger_ids: sourceLedgerIds,
    created_at: Date.now(),
    status: "pending",
  };
}

// ---------------------------------------------------------------------------
// Persistence
// ---------------------------------------------------------------------------

/** Write `settlement:ledger:<id>` to statsKV. Idempotent on `id`. */
export async function persistBatch(env: Env, batch: SettlementBatch): Promise<void> {
  await statsKV(env).put(settlementKey(batch.id), JSON.stringify(batch));
}

/** Read a previously-persisted batch by id. Returns null when absent. */
export async function readBatch(env: Env, batchId: string): Promise<SettlementBatch | null> {
  const raw = (await statsKV(env).get(settlementKey(batchId))) as string | null;
  if (!raw) return null;
  try {
    return JSON.parse(raw) as SettlementBatch;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Execute (sign + submit + stamp)
// ---------------------------------------------------------------------------

export interface ExecuteSettlementResult {
  batch: SettlementBatch;
  /** Present on dry-run AND live execute; the assembled Flex authorization. */
  authorization?: FlexAuthorizationDraft;
  /** Present on dry-run; the bps splits the auth would carry. */
  projected_splits?: FlexSplit[];
  /** Only set on live submit success. */
  tx_signature?: string;
  dry_run: boolean;
}

/**
 * Read the batch, normalise recipients into FlexSplit bps via `mergeSplits`,
 * build a `FlexAuthorizationDraft`. On `dry_run:true` return the draft +
 * projected splits without submitting. On live, call `sendSponsorFlexPayment`,
 * stamp the batch + source rows with `batch_settled_tx`, return the result.
 *
 * Solana RPC + signing inject through `injections` so tests can stub the
 * sponsor-flex path. Production callers pass no injections.
 */
export async function executeSettlement(
  env: Env,
  batchId: string,
  opts: {
    dry_run?: boolean;
    /** Test seam: stub the SOL RPC + flex SDK lookup. Production = undefined. */
    sponsorFlexInjections?: Parameters<typeof sendSponsorFlexPayment>[2];
    /** Test seam: pin the current slot for deterministic draft assembly. */
    currentSlot?: bigint;
  } = {},
): Promise<ExecuteSettlementResult> {
  const dryRun = opts.dry_run === true;
  const batch = await readBatch(env, batchId);
  if (!batch) {
    throw new Error(`settlement batch not found: ${batchId}`);
  }
  if (batch.status === "executed") {
    return {
      batch,
      dry_run: dryRun,
      tx_signature: batch.tx_signature,
    };
  }
  if (batch.recipients.length === 0) {
    throw new Error(`settlement batch ${batchId} has no recipients`);
  }
  if (batch.total_amount_uc <= 0) {
    throw new Error(`settlement batch ${batchId} has non-positive total amount`);
  }

  // Recipients → bps. The aggregator already filters non-positive shares, so
  // every entry contributes a positive bps. Round-half-away from total so the
  // bps sum can drift by ≤recipient_count; we backfill the largest entry to
  // hit exactly 10000.
  const total = batch.total_amount_uc;
  const rawSplits: FlexSplit[] = batch.recipients.map((r) => ({
    recipient: r.wallet,
    bps: Math.max(1, Math.round((r.amount_uc * 10000) / total)),
  }));
  const merged = mergeSplits(rawSplits);
  const sum = merged.reduce((s, x) => s + x.bps, 0);
  if (sum !== 10000) {
    merged.sort((a, b) => b.bps - a.bps);
    merged[0]!.bps += 10000 - sum;
  }

  // Build the draft. Without a configured agentEscrow we can't sign — for
  // dry-run we use the sponsor escrow as the source-of-funds; for live we
  // require it from env via `sendSponsorFlexPayment`'s gate.
  const agentEscrow = env.FLEX_SPONSOR_ESCROW_ADDRESS?.trim() || "DRY-RUN-NO-ESCROW";
  const currentSlot = opts.currentSlot ?? 0n;
  const draft = await buildFlexAuthorization(env, {
    agentEscrow,
    maxAmountUc: BigInt(total),
    splits: merged,
    currentSlot,
  });

  if (dryRun) {
    return {
      batch,
      authorization: draft,
      projected_splits: merged,
      dry_run: true,
    };
  }

  // Live submit. sendSponsorFlexPayment owns the RPC + signing; it returns
  // ok:false on any operational failure (no throw).
  const flexResult = await sendSponsorFlexPayment(
    env,
    {
      agentId: "settlement-service",
      skillId: batch.id, // batch id stands in for the resource handle
      splits: merged,
      amountUc: BigInt(total),
    },
    opts.sponsorFlexInjections,
  );

  const nowIso = new Date().toISOString();
  const nowMs = Date.now();

  if (!flexResult.ok) {
    const failed: SettlementBatch = {
      ...batch,
      status: "failed",
      failure_reason: flexResult.reason ?? "sponsor_flex_submit_failed",
    };
    await persistBatch(env, failed);
    return {
      batch: failed,
      authorization: draft,
      dry_run: false,
    };
  }

  const txSignature = flexResult.tx_signature ?? flexResult.authorization_id ?? "";
  const executed: SettlementBatch = {
    ...batch,
    status: "executed",
    executed_at: nowMs,
    tx_signature: txSignature,
  };
  await persistBatch(env, executed);

  // Stamp each source row so they don't re-aggregate. Best-effort: failures
  // are logged but do not block — the batch row carries the source ids so an
  // operator can replay a partial stamp.
  const kv = statsKV(env);
  await Promise.all(
    batch.source_ledger_ids.map(async (ledgerId) => {
      try {
        const rawRow = (await kv.get(sponsorRowKey(ledgerId))) as string | null;
        if (!rawRow) return;
        const row = JSON.parse(rawRow) as SponsorLedgerRowWithBatch;
        if (row.batch_settled_tx) return;
        row.batch_settled_tx = txSignature;
        row.batch_settled_at = nowIso;
        await kv.put(sponsorRowKey(ledgerId), JSON.stringify(row));
      } catch (err) {
        console.warn(
          `[settlement] failed to stamp source row ${ledgerId}: ${(err as Error).message}`,
        );
      }
    }),
  );

  return {
    batch: executed,
    authorization: draft,
    tx_signature: txSignature,
    dry_run: false,
  };
}
