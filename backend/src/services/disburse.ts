/**
 * Custodial indexer payout — the real-money path we control.
 *
 * Context: the trustless Flex splits rail needs an on-chain escrow/splits
 * program that is deployed on devnet only (Faremeter's `EcfUgNg…`, closed
 * source). So we cannot atomically split on Solana mainnet today. This module
 * is the pragmatic alternative: the platform receives revenue (PayAI exact →
 * treasury), the attribution ledger records each indexer's earned cut, and this
 * sweep pays each indexer their owed balance via a direct USDC SPL transfer
 * from the funded platform wallet (CASCADE_SIGNER_SECRET_KEY).
 *
 * Trust model: the platform briefly custodies and disburses — NOT atomic,
 * on-chain splits. That is the explicit trade-off of running on mainnet before
 * the trustless program ships there.
 *
 * Safety rails (load-bearing):
 *   - Default DRY-RUN: computePayoutPlan() never moves funds.
 *   - executePayouts() refuses unless DISBURSE_ENABLED=1 AND the signer/RPC are
 *     configured. The admin route also gates on the explicit `execute` flag.
 *   - Idempotent: a per-contributor paid ledger (`payout:contributor:{id}`)
 *     tracks cumulative paid_uc; owed = earned − paid, so a re-run never
 *     double-pays an already-settled balance.
 *   - A min threshold (DISBURSE_MIN_USD, default $0.10) skips dust so the SPL
 *     fee never exceeds the payout.
 */

import type { Env } from "../types.js";
import { statsKV } from "./kv.js";
import { listIndexerIds, getIndexerLedger } from "./attribution.js";
import { getAgent } from "./agents.js";
import { sendSponsorPayment } from "./sponsor-pay.js";

const DEFAULT_MIN_USD = 0.1;
const UC_PER_USD = 1_000_000;

function payoutKey(agentId: string): string {
  return `payout:contributor:${agentId}`;
}

/** Cumulative record of what has actually been disbursed to one contributor. */
export interface PayoutLedger {
  agent_id: string;
  wallet_address?: string;
  paid_uc: number;
  payout_count: number;
  first_paid_at?: string;
  last_paid_at?: string;
  txs: Array<{ signature: string; amount_uc: number; at: string }>;
}

export interface PayoutPlanItem {
  agent_id: string;
  wallet_address: string;
  earned_uc: number;
  paid_uc: number;
  owed_uc: number;
  owed_usd: number;
}

export interface PayoutSkip {
  agent_id: string;
  reason: "below_min" | "no_wallet" | "nothing_owed";
  earned_uc: number;
  paid_uc: number;
  owed_uc: number;
}

export interface PayoutPlan {
  generated_at: string;
  min_usd: number;
  disburse_enabled: boolean;
  signer_configured: boolean;
  recipients: PayoutPlanItem[];
  skipped: PayoutSkip[];
  total_owed_uc: number;
  total_owed_usd: number;
  recipient_count: number;
}

export function disburseEnabled(env: Env): boolean {
  const v = env.DISBURSE_ENABLED?.trim().toLowerCase();
  return v === "1" || v === "true";
}

export function disburseMinUsd(env: Env): number {
  const raw = env.DISBURSE_MIN_USD?.trim();
  if (!raw) return DEFAULT_MIN_USD;
  const n = Number.parseFloat(raw);
  return Number.isFinite(n) && n >= 0 ? n : DEFAULT_MIN_USD;
}

function signerConfigured(env: Env): boolean {
  return Boolean(
    env.CASCADE_SIGNER_SECRET_KEY?.trim() &&
      env.CASCADE_RPC_URL?.trim() &&
      env.CASCADE_RPC_WS_URL?.trim(),
  );
}

export async function getPayoutLedger(env: Env, agentId: string): Promise<PayoutLedger> {
  const raw = (await statsKV(env).get(payoutKey(agentId))) as string | null;
  if (raw) {
    try {
      return JSON.parse(raw) as PayoutLedger;
    } catch {
      /* fall through to empty */
    }
  }
  return { agent_id: agentId, paid_uc: 0, payout_count: 0, txs: [] };
}

/**
 * Compute the payout plan WITHOUT moving any funds. owed = earned − already
 * paid, filtered by the min threshold and the presence of a destination wallet.
 */
export async function computePayoutPlan(env: Env): Promise<PayoutPlan> {
  const minUsd = disburseMinUsd(env);
  const minUc = Math.round(minUsd * UC_PER_USD);
  const ids = await listIndexerIds(env);

  const recipients: PayoutPlanItem[] = [];
  const skipped: PayoutSkip[] = [];

  await Promise.all(
    ids.map(async (agentId) => {
      const ledger = await getIndexerLedger(env, agentId);
      const earned_uc = ledger?.total_credited_uc ?? 0;
      const paid = await getPayoutLedger(env, agentId);
      const owed_uc = earned_uc - paid.paid_uc;

      if (owed_uc <= 0) {
        skipped.push({ agent_id: agentId, reason: "nothing_owed", earned_uc, paid_uc: paid.paid_uc, owed_uc });
        return;
      }

      const profile = await getAgent(env, agentId).catch(() => null);
      const wallet = profile?.wallet_address?.trim() || paid.wallet_address?.trim();
      if (!wallet) {
        skipped.push({ agent_id: agentId, reason: "no_wallet", earned_uc, paid_uc: paid.paid_uc, owed_uc });
        return;
      }
      if (owed_uc < minUc) {
        skipped.push({ agent_id: agentId, reason: "below_min", earned_uc, paid_uc: paid.paid_uc, owed_uc });
        return;
      }

      recipients.push({
        agent_id: agentId,
        wallet_address: wallet,
        earned_uc,
        paid_uc: paid.paid_uc,
        owed_uc,
        owed_usd: owed_uc / UC_PER_USD,
      });
    }),
  );

  recipients.sort((a, b) => b.owed_uc - a.owed_uc);
  const total_owed_uc = recipients.reduce((s, r) => s + r.owed_uc, 0);

  return {
    generated_at: new Date().toISOString(),
    min_usd: minUsd,
    disburse_enabled: disburseEnabled(env),
    signer_configured: signerConfigured(env),
    recipients,
    skipped,
    total_owed_uc,
    total_owed_usd: total_owed_uc / UC_PER_USD,
    recipient_count: recipients.length,
  };
}

export interface PayoutResult {
  agent_id: string;
  wallet_address: string;
  amount_uc: number;
  amount_usd: number;
  success: boolean;
  signature?: string;
  error?: string;
}

export interface DisburseExecution {
  executed: boolean;
  reason?: string;
  plan: PayoutPlan;
  results: PayoutResult[];
  paid_uc: number;
  paid_usd: number;
}

/**
 * Execute the payout plan: for each recipient, send their owed USDC via a
 * direct SPL transfer and stamp the paid ledger with the tx signature. Refuses
 * to move funds unless DISBURSE_ENABLED=1 and the signer is configured.
 *
 * Idempotent per recipient: paid_uc only advances on a confirmed signature, so
 * a partial failure is safe to re-run — already-paid balances drop out of the
 * next plan.
 */
export async function executePayouts(env: Env): Promise<DisburseExecution> {
  const plan = await computePayoutPlan(env);

  if (!disburseEnabled(env)) {
    return { executed: false, reason: "disburse_disabled", plan, results: [], paid_uc: 0, paid_usd: 0 };
  }
  if (!signerConfigured(env)) {
    return { executed: false, reason: "signer_not_configured", plan, results: [], paid_uc: 0, paid_usd: 0 };
  }

  const results: PayoutResult[] = [];
  let paid_uc = 0;

  // Sequential — one transfer at a time keeps blockhash/nonce handling simple
  // and bounds the blast radius if the platform wallet runs dry mid-sweep.
  for (const r of plan.recipients) {
    const res = await sendSponsorPayment(env, r.wallet_address, r.owed_uc);
    const out: PayoutResult = {
      agent_id: r.agent_id,
      wallet_address: r.wallet_address,
      amount_uc: r.owed_uc,
      amount_usd: r.owed_usd,
      success: res.success,
      signature: res.signature,
      error: res.error,
    };
    results.push(out);

    if (res.success && res.signature) {
      paid_uc += r.owed_uc;
      const now = new Date().toISOString();
      const ledger = await getPayoutLedger(env, r.agent_id);
      ledger.wallet_address = r.wallet_address;
      ledger.paid_uc += r.owed_uc;
      ledger.payout_count += 1;
      ledger.first_paid_at = ledger.first_paid_at ?? now;
      ledger.last_paid_at = now;
      ledger.txs.push({ signature: res.signature, amount_uc: r.owed_uc, at: now });
      // Cap the tx tail so the row stays small; the full history lives on-chain.
      if (ledger.txs.length > 50) ledger.txs = ledger.txs.slice(-50);
      await statsKV(env).put(payoutKey(r.agent_id), JSON.stringify(ledger));
    }
  }

  return { executed: true, plan, results, paid_uc, paid_usd: paid_uc / UC_PER_USD };
}
