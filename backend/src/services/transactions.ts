/**
 * Transaction ledger service -- Plan 06-02
 *
 * Records skill usage payments so both consumers (agents paying for skills)
 * and creators (indexers earning from their published skills) can view
 * their transaction history.
 *
 * Uses the same KV pattern as fees.ts and attribution.ts:
 * - Per-entity ledgers keyed by agent ID
 * - An index key for enumeration in summaries
 * - All monetary values in micro-cents (1 unit = $0.000001)
 */

import type { Env } from "../types.js";
import { statsKV } from "./kv.js";

// --- Types ---

export interface Transaction {
  transaction_id: string;
  consumer_id: string;
  creator_id: string;
  skill_id: string;
  endpoint_id?: string;
  price_usd: number;
  price_uc: number;
  platform_fee_uc: number;
  creator_payout_uc: number;
  payment_proof?: string;
  status: "completed" | "pending" | "failed";
  created_at: string;
}

export interface ConsumerLedger {
  agent_id: string;
  total_spent_uc: number;
  total_spent_usd: number;
  transaction_count: number;
  first_transaction_at: string;
  last_transaction_at: string;
}

export interface CreatorLedger {
  agent_id: string;
  total_earned_uc: number;
  total_earned_usd: number;
  total_fees_uc: number;
  transaction_count: number;
  first_transaction_at: string;
  last_transaction_at: string;
}

export interface TransactionSummary {
  total_transactions: number;
  total_volume_uc: number;
  total_volume_usd: number;
  total_platform_fees_uc: number;
  total_platform_fees_usd: number;
  total_creator_payouts_uc: number;
  total_creator_payouts_usd: number;
  unique_consumers: number;
  unique_creators: number;
}

const PLATFORM_FEE_RATE = 0.20;

function txKey(txId: string): string { return `tx:${txId}`; }
function consumerLedgerKey(agentId: string): string { return `tx:consumer:${agentId}`; }
function creatorLedgerKey(agentId: string): string { return `tx:creator:${agentId}`; }

const TX_INDEX_KEY = "tx:index";
const CONSUMER_INDEX_KEY = "tx:consumers:index";
const CREATOR_INDEX_KEY = "tx:creators:index";
export async function recordTransaction(
  env: Env,
  params: {
    transaction_id: string;
    consumer_id: string;
    creator_id: string;
    skill_id: string;
    endpoint_id?: string;
    price_usd: number;
    payment_proof?: string;
  },
): Promise<Transaction> {
  const kv = statsKV(env);
  const now = new Date().toISOString();
  const price_uc = Math.round(params.price_usd * 1_000_000);
  const platform_fee_uc = Math.round(price_uc * PLATFORM_FEE_RATE);
  const creator_payout_uc = price_uc - platform_fee_uc;

  const tx: Transaction = {
    transaction_id: params.transaction_id,
    consumer_id: params.consumer_id,
    creator_id: params.creator_id,
    skill_id: params.skill_id,
    endpoint_id: params.endpoint_id,
    price_usd: params.price_usd,
    price_uc,
    platform_fee_uc,
    creator_payout_uc,
    payment_proof: params.payment_proof,
    status: "completed",
    created_at: now,
  };

  await kv.put(txKey(tx.transaction_id), JSON.stringify(tx));
  await updateConsumerLedger(kv, tx);
  await updateCreatorLedger(kv, tx);
  await addToIndex(kv, TX_INDEX_KEY, tx.transaction_id);

  return tx;
}

export async function getConsumerTransactions(
  env: Env,
  agentId: string,
): Promise<{ ledger: ConsumerLedger | null; transactions: Transaction[] }> {
  const kv = statsKV(env);
  const raw = await kv.get(consumerLedgerKey(agentId)) as string | null;
  if (!raw) return { ledger: null, transactions: [] };
  let ledger: ConsumerLedger;
  try { ledger = JSON.parse(raw) as ConsumerLedger; } catch { return { ledger: null, transactions: [] }; }
  const transactions = await getTransactionsByParticipant(kv, agentId, "consumer");
  return { ledger, transactions };
}

export async function getCreatorTransactions(
  env: Env,
  agentId: string,
): Promise<{ ledger: CreatorLedger | null; transactions: Transaction[] }> {
  const kv = statsKV(env);
  const raw = await kv.get(creatorLedgerKey(agentId)) as string | null;
  if (!raw) return { ledger: null, transactions: [] };
  let ledger: CreatorLedger;
  try { ledger = JSON.parse(raw) as CreatorLedger; } catch { return { ledger: null, transactions: [] }; }
  const transactions = await getTransactionsByParticipant(kv, agentId, "creator");
  return { ledger, transactions };
}
export async function getTransactionSummary(env: Env): Promise<TransactionSummary> {
  const kv = statsKV(env);
  const [consumerIndexRaw, creatorIndexRaw] = await Promise.all([
    kv.get(CONSUMER_INDEX_KEY) as Promise<string | null>,
    kv.get(CREATOR_INDEX_KEY) as Promise<string | null>,
  ]);
  const consumerIds: string[] = consumerIndexRaw ? (JSON.parse(consumerIndexRaw) as string[]) : [];
  const creatorIds: string[] = creatorIndexRaw ? (JSON.parse(creatorIndexRaw) as string[]) : [];

  const summary: TransactionSummary = {
    total_transactions: 0, total_volume_uc: 0, total_volume_usd: 0,
    total_platform_fees_uc: 0, total_platform_fees_usd: 0,
    total_creator_payouts_uc: 0, total_creator_payouts_usd: 0,
    unique_consumers: consumerIds.length, unique_creators: creatorIds.length,
  };

  const ledgers = await Promise.all(
    consumerIds.map(async (id) => {
      const raw = await kv.get(consumerLedgerKey(id)) as string | null;
      if (!raw) return null;
      try { return JSON.parse(raw) as ConsumerLedger; } catch { return null; }
    }),
  );
  const cLedgers = await Promise.all(
    creatorIds.map(async (id) => {
      const raw = await kv.get(creatorLedgerKey(id)) as string | null;
      if (!raw) return null;
      try { return JSON.parse(raw) as CreatorLedger; } catch { return null; }
    }),
  );

  for (const ledger of ledgers) {
    if (!ledger) continue;
    summary.total_transactions += ledger.transaction_count;
    summary.total_volume_uc += ledger.total_spent_uc;
  }
  for (const cl of cLedgers) {
    if (!cl) continue;
    summary.total_platform_fees_uc += cl.total_fees_uc;
    summary.total_creator_payouts_uc += cl.total_earned_uc;
  }

  summary.total_volume_usd = summary.total_volume_uc / 1_000_000;
  summary.total_platform_fees_usd = summary.total_platform_fees_uc / 1_000_000;
  summary.total_creator_payouts_usd = summary.total_creator_payouts_uc / 1_000_000;
  return summary;
}
// --- Helpers ---

async function updateConsumerLedger(kv: ReturnType<typeof statsKV>, tx: Transaction): Promise<void> {
  const key = consumerLedgerKey(tx.consumer_id);
  const raw = await kv.get(key) as string | null;
  let ledger: ConsumerLedger;
  if (raw) {
    try { ledger = JSON.parse(raw) as ConsumerLedger; } catch {
      ledger = emptyConsumerLedger(tx.consumer_id, tx.created_at);
    }
  } else {
    ledger = emptyConsumerLedger(tx.consumer_id, tx.created_at);
    await addToIndex(kv, CONSUMER_INDEX_KEY, tx.consumer_id);
  }
  ledger.total_spent_uc += tx.price_uc;
  ledger.total_spent_usd = ledger.total_spent_uc / 1_000_000;
  ledger.transaction_count++;
  ledger.last_transaction_at = tx.created_at;
  await kv.put(key, JSON.stringify(ledger));
}

async function updateCreatorLedger(kv: ReturnType<typeof statsKV>, tx: Transaction): Promise<void> {
  const key = creatorLedgerKey(tx.creator_id);
  const raw = await kv.get(key) as string | null;
  let ledger: CreatorLedger;
  if (raw) {
    try { ledger = JSON.parse(raw) as CreatorLedger; } catch {
      ledger = emptyCreatorLedger(tx.creator_id, tx.created_at);
    }
  } else {
    ledger = emptyCreatorLedger(tx.creator_id, tx.created_at);
    await addToIndex(kv, CREATOR_INDEX_KEY, tx.creator_id);
  }
  ledger.total_earned_uc += tx.creator_payout_uc;
  ledger.total_earned_usd = ledger.total_earned_uc / 1_000_000;
  ledger.total_fees_uc += tx.platform_fee_uc;
  ledger.transaction_count++;
  ledger.last_transaction_at = tx.created_at;
  await kv.put(key, JSON.stringify(ledger));
}

function emptyConsumerLedger(agentId: string, now: string): ConsumerLedger {
  return { agent_id: agentId, total_spent_uc: 0, total_spent_usd: 0, transaction_count: 0, first_transaction_at: now, last_transaction_at: now };
}

function emptyCreatorLedger(agentId: string, now: string): CreatorLedger {
  return { agent_id: agentId, total_earned_uc: 0, total_earned_usd: 0, total_fees_uc: 0, transaction_count: 0, first_transaction_at: now, last_transaction_at: now };
}

async function addToIndex(kv: ReturnType<typeof statsKV>, indexKey: string, id: string): Promise<void> {
  const raw = await kv.get(indexKey) as string | null;
  const ids: string[] = raw ? (JSON.parse(raw) as string[]) : [];
  if (!ids.includes(id)) {
    ids.push(id);
    await kv.put(indexKey, JSON.stringify(ids));
  }
}

async function getTransactionsByParticipant(
  kv: ReturnType<typeof statsKV>,
  agentId: string,
  role: "consumer" | "creator",
): Promise<Transaction[]> {
  const indexRaw = await kv.get(TX_INDEX_KEY) as string | null;
  const txIds: string[] = indexRaw ? (JSON.parse(indexRaw) as string[]) : [];
  if (txIds.length === 0) return [];
  const recentIds = txIds.slice(-100).reverse();
  const txs = await Promise.all(
    recentIds.map(async (id) => {
      const raw = await kv.get(txKey(id)) as string | null;
      if (!raw) return null;
      try { return JSON.parse(raw) as Transaction; } catch { return null; }
    }),
  );
  return txs.filter((tx): tx is Transaction => {
    if (!tx) return false;
    return role === "consumer" ? tx.consumer_id === agentId : tx.creator_id === agentId;
  });
}