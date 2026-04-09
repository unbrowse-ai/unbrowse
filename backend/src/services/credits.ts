/**
 * Credit subsidy ledger — agent onboarding credits
 *
 * Tracks subsidized credits per agent to reduce friction for new agents.
 * New agents receive welcome credits from a capped subsidy pool on registration.
 * As agents index routes and earn attribution from other agents' usage,
 * earned credits accumulate alongside the grant. The goal is self-sustaining
 * agents that earn more than they consume.
 *
 * All values in micro-cents (µ¢, 1 unit = $0.000001).
 * $1 = 1,000,000 µ¢.
 */

import type { Env } from "../types.js";
import { statsKV } from "./kv.js";

// ─── Types ────────────────────────────────────────────────────────────────────

export interface CreditBalance {
  agent_id: string;
  /** Credits given from the subsidy pool. */
  granted_uc: number;
  /** Credits earned from other agents using this agent's routes. */
  earned_uc: number;
  /** Credits spent on API calls. */
  consumed_uc: number;
  /** granted + earned - consumed */
  balance_uc: number;
  /** True when earned_uc > consumed_uc over recent activity. */
  is_self_sustaining: boolean;
  created_at: string;
  updated_at: string;
}

export interface SubsidyPool {
  /** Total budget allocated to the subsidy pool (µ¢). */
  total_budget_uc: number;
  /** Total credits granted to agents so far (µ¢). */
  total_granted_uc: number;
  /** Remaining budget: total_budget_uc - total_granted_uc (µ¢). */
  remaining_uc: number;
  /** Number of agents that have received grants. */
  grants_count: number;
  /** Maximum credits per agent (µ¢). */
  per_agent_cap_uc: number;
}

// ─── Key helpers ──────────────────────────────────────────────────────────────

function creditBalanceKey(agentId: string): string {
  return `credits:agent:${agentId}`;
}

const POOL_KEY = "credits:pool";

// ─── Service functions ────────────────────────────────────────────────────────

/**
 * Initialize or update the subsidy pool configuration.
 * If a pool already exists, updates its budget and cap (preserving grant history).
 */
export async function initSubsidyPool(
  env: Env,
  budget_uc: number,
  per_agent_cap_uc: number,
): Promise<SubsidyPool> {
  const kv = statsKV(env);
  const existing = await getPoolStatus(env);

  const pool: SubsidyPool = {
    total_budget_uc: budget_uc,
    total_granted_uc: existing?.total_granted_uc ?? 0,
    remaining_uc: budget_uc - (existing?.total_granted_uc ?? 0),
    grants_count: existing?.grants_count ?? 0,
    per_agent_cap_uc,
  };

  await kv.put(POOL_KEY, JSON.stringify(pool));
  return pool;
}

/**
 * Grant credits to an agent from the subsidy pool.
 * Defaults to the pool's per_agent_cap_uc if amount is not specified.
 * Returns null if the pool doesn't exist, is exhausted, or the agent
 * already has a grant.
 */
export async function grantCredits(
  env: Env,
  agent_id: string,
  amount_uc?: number,
): Promise<CreditBalance | null> {
  const kv = statsKV(env);

  // Check if agent already has credits
  const existing = await getBalance(env, agent_id);
  if (existing && existing.granted_uc > 0) {
    return existing; // Already granted — idempotent
  }

  // Load pool
  const poolRaw = await kv.get(POOL_KEY) as string | null;
  if (!poolRaw) return null;

  let pool: SubsidyPool;
  try { pool = JSON.parse(poolRaw) as SubsidyPool; } catch { return null; }

  const grant = amount_uc ?? pool.per_agent_cap_uc;
  if (grant <= 0 || pool.remaining_uc < grant) return null;

  const now = new Date().toISOString();
  const balance: CreditBalance = {
    agent_id,
    granted_uc: grant,
    earned_uc: existing?.earned_uc ?? 0,
    consumed_uc: existing?.consumed_uc ?? 0,
    balance_uc: grant + (existing?.earned_uc ?? 0) - (existing?.consumed_uc ?? 0),
    is_self_sustaining: false,
    created_at: existing?.created_at ?? now,
    updated_at: now,
  };

  // Update pool
  pool.total_granted_uc += grant;
  pool.remaining_uc = pool.total_budget_uc - pool.total_granted_uc;
  pool.grants_count++;

  await kv.put(creditBalanceKey(agent_id), JSON.stringify(balance));
  await kv.put(POOL_KEY, JSON.stringify(pool));

  return balance;
}

/**
 * Debit credits for API usage.
 * Returns success=false if insufficient balance.
 */
export async function debitCredits(
  env: Env,
  agent_id: string,
  amount_uc: number,
): Promise<{ success: boolean; remaining_balance_uc: number }> {
  const kv = statsKV(env);
  const balance = await getBalance(env, agent_id);

  if (!balance) {
    return { success: false, remaining_balance_uc: 0 };
  }

  if (balance.balance_uc < amount_uc) {
    return { success: false, remaining_balance_uc: balance.balance_uc };
  }

  balance.consumed_uc += amount_uc;
  balance.balance_uc = balance.granted_uc + balance.earned_uc - balance.consumed_uc;
  balance.is_self_sustaining = balance.earned_uc > balance.consumed_uc;
  balance.updated_at = new Date().toISOString();

  await kv.put(creditBalanceKey(agent_id), JSON.stringify(balance));
  return { success: true, remaining_balance_uc: balance.balance_uc };
}

/**
 * Credit earnings from other agents using this agent's routes.
 * Creates a balance entry if one doesn't exist yet.
 */
export async function creditEarnings(
  env: Env,
  agent_id: string,
  amount_uc: number,
): Promise<CreditBalance> {
  const kv = statsKV(env);
  const now = new Date().toISOString();
  let balance = await getBalance(env, agent_id);

  if (!balance) {
    balance = emptyBalance(agent_id, now);
  }

  balance.earned_uc += amount_uc;
  balance.balance_uc = balance.granted_uc + balance.earned_uc - balance.consumed_uc;
  balance.is_self_sustaining = balance.earned_uc > balance.consumed_uc;
  balance.updated_at = now;

  await kv.put(creditBalanceKey(agent_id), JSON.stringify(balance));
  return balance;
}

/**
 * Get the full credit balance for an agent.
 * Returns null if no balance record exists.
 */
export async function getBalance(
  env: Env,
  agent_id: string,
): Promise<CreditBalance | null> {
  const raw = await statsKV(env).get(creditBalanceKey(agent_id)) as string | null;
  if (!raw) return null;
  try { return JSON.parse(raw) as CreditBalance; } catch { return null; }
}

/**
 * Get current subsidy pool status.
 * Returns null if the pool hasn't been initialized.
 */
export async function getPoolStatus(env: Env): Promise<SubsidyPool | null> {
  const raw = await statsKV(env).get(POOL_KEY) as string | null;
  if (!raw) return null;
  try { return JSON.parse(raw) as SubsidyPool; } catch { return null; }
}

/**
 * Check if an agent is self-sustaining (earning more than consuming).
 */
export async function checkSelfSustaining(
  env: Env,
  agent_id: string,
): Promise<{ is_self_sustaining: boolean; earned_uc: number; consumed_uc: number }> {
  const balance = await getBalance(env, agent_id);
  if (!balance) {
    return { is_self_sustaining: false, earned_uc: 0, consumed_uc: 0 };
  }
  return {
    is_self_sustaining: balance.earned_uc > balance.consumed_uc,
    earned_uc: balance.earned_uc,
    consumed_uc: balance.consumed_uc,
  };
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function emptyBalance(agentId: string, now: string): CreditBalance {
  return {
    agent_id: agentId,
    granted_uc: 0,
    earned_uc: 0,
    consumed_uc: 0,
    balance_uc: 0,
    is_self_sustaining: false,
    created_at: now,
    updated_at: now,
  };
}
