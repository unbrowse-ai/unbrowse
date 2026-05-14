/**
 * Sponsor middleware — platform-funded first calls for new agents.
 *
 * Day 4 (Genesis Luminaries) implementation: pure decision function. Returns a
 * SponsorDecision describing one of three outcomes (sponsored | exhausted |
 * opted_out). NEVER throws on a normal "refused to sponsor" outcome — the
 * caller decides whether to short-circuit the 402 or fall through.
 *
 * Wallet env contract:
 *   PLATFORM_SPONSOR_WALLET_ADDRESS — public address (binding, .env). Advertised
 *                                     to creators in response headers and ledger
 *                                     rows; this is the payer-of-record.
 *   PLATFORM_SPONSOR_WALLET_KEY    — gate-only as of v6.15.0. Must be set for
 *                                     sponsor mode to enable, but the value is
 *                                     NOT used for signing. Actual USDC settlement
 *                                     in v6.16+ rides on Faremeter Flex: the
 *                                     sponsor authorization is signed against the
 *                                     sponsor escrow with the agent's skill splits
 *                                     (see `services/sponsor-flex.ts`), and the
 *                                     platform recoups its 10% through the same
 *                                     authorization's splits array. `CASCADE_RPC_URL`
 *                                     and `CASCADE_RPC_WS_URL` are still read as
 *                                     the Solana RPC binding (rename to
 *                                     `SOLANA_RPC_URL` deferred to v6.17 for
 *                                     deploy safety).
 *   SPONSOR_CAP_DAILY_USD          — per-agent cap, default 1.0
 *   SPONSOR_GLOBAL_DAILY_USD       — org-wide cap, default 50.0
 *
 * Storage:
 *   sponsor:agent:<agent_id>:<YYYY-MM-DD> — running USD-cents spend for one agent
 *   sponsor:global:<YYYY-MM-DD>           — running USD-cents spend org-wide
 *   sponsor:ledger:<ledger_id>            — one JSON row per settled sponsor payment
 *
 * All KV values stored as JSON strings. Spend rollups use integer micro-cents
 * (µ¢, $1 = 1_000_000 µ¢) to avoid float drift; caps stay USD for human
 * readability and are converted at compare time.
 */

import type { Context } from "hono";
import type { Env } from "../types.js";
import type { X402PaymentRequirementV2 } from "./x402-gate.js";
import { sendSponsorPayment } from "../services/sponsor-pay.js";
import {
  sendSponsorFlexPayment,
  sponsorUseFlex,
  type SponsorFlexResult,
} from "../services/sponsor-flex.js";
import type { FlexSplit } from "../services/flex.js";
import { statsKV } from "../services/kv.js";

export type SponsorDecision =
  | {
      kind: "sponsored";
      tx_hash: string;
      amount_usdc: string;
      remaining_credit_usd: number;
      ledger_id: string;
    }
  | {
      kind: "exhausted";
      reason: "agent_cap" | "global_cap" | "no_wallet";
      remaining_credit_usd: number;
    }
  | { kind: "opted_out" };

/**
 * Narrow env shape for the pure helpers. Kept separate from the full Env so
 * unit tests can pass synthetic objects without filling 60+ fields.
 */
export interface SponsorEnv {
  PLATFORM_SPONSOR_WALLET_ADDRESS?: string;
  PLATFORM_SPONSOR_WALLET_KEY?: string;
  SPONSOR_CAP_DAILY_USD?: string;
  SPONSOR_GLOBAL_DAILY_USD?: string;
}

/** True iff both the public address and the signer key are present. */
export function sponsorWalletReady(env: SponsorEnv): boolean {
  const addr = env.PLATFORM_SPONSOR_WALLET_ADDRESS?.trim();
  const key = env.PLATFORM_SPONSOR_WALLET_KEY?.trim();
  return Boolean(addr && key);
}

/** Per-agent daily cap in USD. Defaults to $1.00 when env var is unset/invalid. */
export function sponsorCapDailyUsd(env: SponsorEnv): number {
  const raw = env.SPONSOR_CAP_DAILY_USD?.trim();
  if (!raw) return 1.0;
  const parsed = parseFloat(raw);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : 1.0;
}

/** Org-wide daily cap in USD. Defaults to $50.00 when env var is unset/invalid. */
export function sponsorGlobalCapDailyUsd(env: SponsorEnv): number {
  const raw = env.SPONSOR_GLOBAL_DAILY_USD?.trim();
  if (!raw) return 50.0;
  const parsed = parseFloat(raw);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : 50.0;
}

export interface SponsorLedgerRow {
  ledger_id: string;
  /** "sponsor" discriminator distinguishes from existing credit ledger entries. */
  kind: "sponsor";
  agent_id: string;
  skill_id: string;
  /** USDC amount in micro-cents (1_000_000 = $1 = 1 USDC). */
  amount_uc: number;
  /** Route creator's wallet (payTo from the chosen payment term). */
  creator_wallet: string;
  /** Solana tx signature returned by sendSponsorPayment OR Flex facilitator. */
  settled_tx: string;
  settled_at: string;
  /**
   * Payment rail (v6.16+): "direct_spl" when the legacy `sendSponsorPayment`
   * codepath ran, "flex" when the sponsor-on-Flex authorization was minted.
   * Older rows (v6.15) elide this field — readers treat absent as "direct_spl".
   */
  payment_method?: "direct_spl" | "flex";
  /** Flex authorization id (only present when payment_method === "flex"). */
  authorization_id?: string;
}

interface MaybeSponsorOpts {
  /** Test seam: inject a fake direct-SPL payment fn (no real RPC). */
  payFn?: typeof sendSponsorPayment;
  /** Test seam: inject a fake Flex payment fn (no real signing / RPC). */
  flexPayFn?: typeof sendSponsorFlexPayment;
  /**
   * Caller-supplied splits for the Flex rail. When `sponsorUseFlex(env)` is
   * true AND this is non-empty, the Flex path is used. When the gate is on
   * but splits are missing (e.g. caller hasn't wired Flex yet), the
   * middleware degrades silently to direct-SPL and emits a one-shot warn.
   */
  flexSplits?: FlexSplit[];
  /** Test seam: inject a fixed clock for deterministic date buckets. */
  now?: () => Date;
}

// One warn per cold-start when wallet env is missing.
let warnedNoWallet = false;
// One warn per cold-start when SPONSOR_USE_FLEX_SPLIT=1 but no splits arrive.
let warnedFlexNoSplits = false;

function todayUtc(now: Date): string {
  // YYYY-MM-DD in UTC. Matches what creditEarnings / analytics buckets use.
  return now.toISOString().slice(0, 10);
}

/** Internal: best-effort read of a uint µ¢ counter from KV.
 *
 * Prefers statsKV(env) (Pg / EmergentDB / LocalKV per env). Falls back to the
 * raw env.STATS_KV (CloudFlare KVNamespace) when statsKV() is unavailable —
 * keeps unit tests that pass a hand-rolled KV-shaped object working even when
 * EMERGENTDB_API_KEY / DATABASE_URL aren't set. */
async function readSpend(env: Env, key: string): Promise<number> {
  try {
    let raw: string | null = null;
    try {
      raw = (await statsKV(env).get(key)) as string | null;
    } catch {
      raw = await env.STATS_KV.get(key);
    }
    if (!raw) return 0;
    const n = Number.parseInt(raw, 10);
    return Number.isFinite(n) && n >= 0 ? n : 0;
  } catch {
    return 0;
  }
}

/** Internal: write the uint µ¢ counter back. KV does not give us CAS but per-
 * agent-per-day collisions are rare enough that read-modify-write is fine for
 * a $1 cap; the worst case is one extra sponsored call before the bucket flips.
 */
async function writeSpend(env: Env, key: string, valueUc: number): Promise<void> {
  try {
    try {
      await statsKV(env).put(key, String(valueUc));
      return;
    } catch {
      await env.STATS_KV.put(key, String(valueUc));
    }
  } catch (err) {
    console.warn(`[sponsor] failed to write spend rollup ${key}: ${(err as Error).message}`);
  }
}

/** Internal: append a ledger row. */
async function writeLedgerRow(env: Env, row: SponsorLedgerRow): Promise<void> {
  try {
    try {
      await statsKV(env).put(`sponsor:ledger:${row.ledger_id}`, JSON.stringify(row));
      return;
    } catch {
      await env.STATS_KV.put(`sponsor:ledger:${row.ledger_id}`, JSON.stringify(row));
    }
  } catch (err) {
    console.warn(`[sponsor] failed to write ledger row ${row.ledger_id}: ${(err as Error).message}`);
  }
}

/**
 * Decide whether to sponsor this call.
 *
 * Order of checks:
 *   1. X-No-Sponsor header → opted_out (no KV reads, no wallet probe).
 *   2. !sponsorWalletReady → exhausted{no_wallet}.
 *   3. agent cap exceeded → exhausted{agent_cap}.
 *   4. global cap exceeded → exhausted{global_cap}.
 *   5. sendSponsorPayment OK → sponsored with tx_hash + ledger row.
 *   6. sendSponsorPayment fails → exhausted{no_wallet} (graceful — never throws).
 *
 * The caller is the route handler; it picks the first paymentTerm (any chain;
 * USDC amount is identical across both Solana and Base USDC mints). The amount
 * is the integer USDC base-unit string from paymentTerms[0].amount; we parse
 * that to a number of µ¢ (they're 1:1 since both have 6 decimals).
 */
// Context is intentionally permissive: this middleware is called from routes
// whose Variables shapes differ (skills.ts has agent_id + user_id, search.ts
// has none). Hono Context generics are invariant so we type-erase Variables
// here. The middleware only reads c.req.header / c.req.url / c.env which exist
// on every Context<{Bindings: Env}>.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type SponsorContext = Context<{ Bindings: Env; Variables: any }>;

export async function maybeSponsor(
  c: SponsorContext,
  paymentTerms: X402PaymentRequirementV2[],
  agentId: string,
  opts?: MaybeSponsorOpts,
): Promise<SponsorDecision> {
  // 1. Opt-out check first — costs nothing.
  if (c.req.header("X-No-Sponsor") === "1") {
    return { kind: "opted_out" };
  }

  const env = c.env;

  // 2. Wallet ready? If not, refuse-to-enable (debounced warn).
  if (!sponsorWalletReady(env)) {
    if (!warnedNoWallet) {
      warnedNoWallet = true;
      console.warn(
        "[sponsor] PLATFORM_SPONSOR_WALLET_ADDRESS/PLATFORM_SPONSOR_WALLET_KEY not set; sponsor mode refuses-to-enable. Standard 402 flow unchanged.",
      );
    }
    return { kind: "exhausted", reason: "no_wallet", remaining_credit_usd: 0 };
  }

  // Pick the first payment term — both chains in our default accepts[] carry
  // the same USDC base-unit amount, so any is fine for the µ¢ derivation. We
  // pay the term's payTo (the creator wallet) directly.
  const term = paymentTerms[0];
  if (!term) {
    return { kind: "exhausted", reason: "no_wallet", remaining_credit_usd: 0 };
  }
  const amountUc = Number.parseInt(term.amount, 10);
  if (!Number.isFinite(amountUc) || amountUc <= 0) {
    return { kind: "exhausted", reason: "no_wallet", remaining_credit_usd: 0 };
  }

  // 3 + 4. Cap checks. Read today's running spend for this agent + global.
  const nowDate = (opts?.now ?? (() => new Date()))();
  const dateStr = todayUtc(nowDate);
  const agentKey = `sponsor:agent:${agentId}:${dateStr}`;
  const globalKey = `sponsor:global:${dateStr}`;

  const [agentSpentUc, globalSpentUc] = await Promise.all([
    readSpend(env, agentKey),
    readSpend(env, globalKey),
  ]);

  const agentCapUsd = sponsorCapDailyUsd(env);
  const globalCapUsd = sponsorGlobalCapDailyUsd(env);
  const agentCapUc = Math.round(agentCapUsd * 1_000_000);
  const globalCapUc = Math.round(globalCapUsd * 1_000_000);

  if (agentSpentUc + amountUc > agentCapUc) {
    return {
      kind: "exhausted",
      reason: "agent_cap",
      remaining_credit_usd: Math.max(0, (agentCapUc - agentSpentUc) / 1_000_000),
    };
  }
  if (globalSpentUc + amountUc > globalCapUc) {
    return {
      kind: "exhausted",
      reason: "global_cap",
      remaining_credit_usd: Math.max(0, (globalCapUc - globalSpentUc) / 1_000_000),
    };
  }

  // 5. Send payment. Two rails:
  //    - v6.16 Flex rail: opt-in via SPONSOR_USE_FLEX_SPLIT=1. Requires the
  //      caller to pass `flexSplits` (the route knows the skill's contributors;
  //      maybeSponsor does not). Caps already checked; this signs a Flex
  //      authorization against the sponsor escrow with the skill's splits.
  //    - v6.15 direct-SPL rail: default. `sendSponsorPayment` transfers USDC
  //      from the sponsor wallet straight to the creator's wallet.
  //  Both rails return `{ ok | success, signature | authorization_id }`.
  let settledTx: string;
  let paymentMethod: "direct_spl" | "flex" = "direct_spl";
  let authorizationId: string | undefined;

  const flexGateOn = sponsorUseFlex(env);
  const flexSplits = opts?.flexSplits;
  const useFlex = flexGateOn && Array.isArray(flexSplits) && flexSplits.length > 0;

  if (flexGateOn && !useFlex && !warnedFlexNoSplits) {
    warnedFlexNoSplits = true;
    console.warn(
      "[sponsor] SPONSOR_USE_FLEX_SPLIT=1 but caller did not pass flexSplits; falling back to direct-SPL for this call.",
    );
  }

  if (useFlex) {
    const flexFn = opts?.flexPayFn ?? sendSponsorFlexPayment;
    let flexResult: SponsorFlexResult;
    try {
      flexResult = await flexFn(env, {
        agentId,
        skillId: extractSkillIdFromUrl(c.req.url),
        splits: flexSplits!,
        amountUc: BigInt(amountUc),
      });
    } catch (err) {
      console.error(`[sponsor] flexPayFn threw: ${(err as Error).message}`);
      return { kind: "exhausted", reason: "no_wallet", remaining_credit_usd: 0 };
    }
    if (!flexResult.ok || !flexResult.authorization_id) {
      console.warn(`[sponsor] flex authorization failed: ${flexResult.reason ?? "unknown"}`);
      return { kind: "exhausted", reason: "no_wallet", remaining_credit_usd: 0 };
    }
    paymentMethod = "flex";
    authorizationId = flexResult.authorization_id;
    // The tx is finalised asynchronously when the facilitator drains. For the
    // ledger row we record the authorization id as `settled_tx` until the
    // sweep promotes it to the on-chain signature. Decision payload carries
    // both fields explicitly.
    settledTx = flexResult.tx_signature ?? flexResult.authorization_id;
  } else {
    const payFn = opts?.payFn ?? sendSponsorPayment;
    let payResult: Awaited<ReturnType<typeof sendSponsorPayment>>;
    try {
      payResult = await payFn(env, term.payTo, amountUc);
    } catch (err) {
      console.error(`[sponsor] payFn threw: ${(err as Error).message}`);
      return { kind: "exhausted", reason: "no_wallet", remaining_credit_usd: 0 };
    }

    if (!payResult?.success || !payResult.signature) {
      console.warn(`[sponsor] payment failed: ${payResult?.error ?? "unknown"}`);
      return { kind: "exhausted", reason: "no_wallet", remaining_credit_usd: 0 };
    }
    settledTx = payResult.signature;
  }

  // Settled. Bump rollups + write ledger row.
  const ledgerId = `spr-${dateStr}-${crypto.randomUUID().slice(0, 8)}`;
  const skillIdFromPath = extractSkillIdFromUrl(c.req.url);
  const row: SponsorLedgerRow = {
    ledger_id: ledgerId,
    kind: "sponsor",
    agent_id: agentId,
    skill_id: skillIdFromPath,
    amount_uc: amountUc,
    creator_wallet: term.payTo,
    settled_tx: settledTx,
    settled_at: nowDate.toISOString(),
    payment_method: paymentMethod,
    ...(authorizationId ? { authorization_id: authorizationId } : {}),
  };

  // Best-effort: bump rollups + write row in parallel. Failures of these are
  // logged but do NOT change the user-visible decision — the USDC already
  // moved, the request is sponsored.
  await Promise.all([
    writeSpend(env, agentKey, agentSpentUc + amountUc),
    writeSpend(env, globalKey, globalSpentUc + amountUc),
    writeLedgerRow(env, row),
  ]);

  return {
    kind: "sponsored",
    tx_hash: settledTx,
    amount_usdc: term.amount,
    remaining_credit_usd: Math.max(0, (agentCapUc - agentSpentUc - amountUc) / 1_000_000),
    ledger_id: ledgerId,
  };
}

/** Best-effort skill_id extraction from URLs like /v1/skills/<id>/execute or
 *  /v1/skills/<id>. Returns "unknown" if pattern doesn't match — never throws. */
function extractSkillIdFromUrl(rawUrl: string): string {
  try {
    const url = new URL(rawUrl);
    const match = url.pathname.match(/\/skills\/([^/]+)/);
    if (match?.[1]) return match[1];
    const demo = url.pathname.match(/\/demos\/([^/]+)/);
    if (demo?.[1]) return `demo-${demo[1]}`;
    return "unknown";
  } catch {
    return "unknown";
  }
}

// Test-only: reset module state between tests.
export function _resetSponsorMiddlewareStateForTests(): void {
  warnedNoWallet = false;
  warnedFlexNoSplits = false;
}
