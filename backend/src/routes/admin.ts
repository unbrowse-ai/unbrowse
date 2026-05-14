/**
 * Admin routes — read-side ops gated by `ADMIN_KEY` (separate from `API_KEY`
 * so the operations surface rotates independently from the legacy CLI token).
 *
 * Day 5 (Genesis Creatures): `GET /v1/admin/sponsor-ledger` returns settled
 * sponsor rows written by `middleware/sponsor.ts:writeLedgerRow`. The on-disk
 * row shape uses `amount_uc` (micro-cents) and `settled_at` (ISO string);
 * USDC has 6 decimals so micro-cents map 1:1 to USDC atomic units. The
 * response converts to `amount_usdc` (atomic-unit string) and
 * `created_at_ms` (unix ms) so downstream tooling never has to know about the
 * µ¢ accounting trick.
 *
 * Day 6 (Genesis Dominion): `GET /v1/analytics/payments` (P5.1 from the
 * x402-routing-plan-v6.16). Closes the v6.15.0 D3 TODO that lived above. The
 * endpoint returns the schema-correct shape defined in the plan, but only the
 * fields that are actually instrumentable today (the sponsor ledger) carry
 * real values; everything that depends on a settlement-ledger we don't yet
 * write (creator payouts, platform cut) or on facilitator-snapshot APIs we
 * don't yet expose (Flex escrow state) returns `"0.00"` / `0`. The response
 * carries `_partial: true` plus an `_instrumented_fields` array so callers
 * know which numbers are real. This is better than fabricating numbers or
 * hiding the endpoint until everything is wired.
 */

import { Hono, type Context } from "hono";
import type { Env } from "../types.js";
import { statsKV } from "../services/kv.js";
import type { SponsorLedgerRow } from "../middleware/sponsor.js";

type AdminEnv = { Bindings: Env; Variables: Record<string, never> };

export const adminRoutes = new Hono<AdminEnv>();

const SPONSOR_LEDGER_PREFIX = "sponsor:ledger:";
const DEFAULT_LIMIT = 100;
const MAX_LIMIT = 1000;

/** Timing-safe equality so attackers cannot derive ADMIN_KEY length/prefix from response time. */
function safeCompare(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) {
    diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return diff === 0;
}

/**
 * Returns true iff the request carries `Authorization: Bearer <ADMIN_KEY>`
 * matching the configured env var. Never echoes the configured key in any
 * branch — both missing and mismatched are surfaced as opaque 401.
 */
function isAdmin(c: Context<AdminEnv>): boolean {
  const configured = c.env.ADMIN_KEY?.trim();
  if (!configured) return false; // refuse-to-enable when unconfigured
  const header = c.req.header("Authorization");
  if (!header?.startsWith("Bearer ")) return false;
  const token = header.slice(7);
  return safeCompare(token, configured);
}

/** Parse a unix-ms or unix-second number safely. Negative / NaN → undefined. */
function parsePositiveInt(raw: string | undefined): number | undefined {
  if (!raw) return undefined;
  const n = Number.parseInt(raw, 10);
  if (!Number.isFinite(n) || n < 0) return undefined;
  return n;
}

interface SponsorLedgerResponseRow {
  ledger_id: string;
  agent_id: string;
  skill_id: string;
  /** USDC atomic units (6 decimals). String to avoid float drift in JSON. */
  amount_usdc: string;
  creator_wallet: string;
  settled_tx: string;
  created_at_ms: number;
  kind: "sponsor";
}

function toResponseRow(row: SponsorLedgerRow): SponsorLedgerResponseRow {
  // Middleware stores µ¢; USDC atomic units (6 decimals) are 1:1 with µ¢
  // ($1 = 1 USDC = 1_000_000 atomic units = 1_000_000 µ¢).
  const createdMs = Date.parse(row.settled_at);
  return {
    ledger_id: row.ledger_id,
    agent_id: row.agent_id,
    skill_id: row.skill_id,
    amount_usdc: String(row.amount_uc),
    creator_wallet: row.creator_wallet,
    settled_tx: row.settled_tx,
    created_at_ms: Number.isFinite(createdMs) ? createdMs : 0,
    kind: "sponsor",
  };
}

/** Day 6 Dominion: the sponsor row shape returned by `readSponsorLedgerRows`.
 *  `SponsorLedgerRow` is the source-of-truth type from `middleware/sponsor.ts`;
 *  `payment_method` is already declared there as
 *  `"direct_spl" | "flex" | undefined`. Re-exported here so external callers
 *  (analytics dashboard, etc.) can import the canonical row shape from the
 *  admin module instead of the middleware path. */
export type SponsorLedgerRowWithMethod = SponsorLedgerRow;

/**
 * Shared helper: stream every well-formed sponsor ledger row out of the stats
 * KV namespace. Used by both `/v1/admin/sponsor-ledger` (table view) and
 * `/v1/analytics/payments` (aggregations).
 *
 * Skips:
 *  - Rows that fail JSON.parse (corrupted writes)
 *  - Rows missing `kind === "sponsor"` (foreign rows under same prefix)
 *  - Rows missing `ledger_id` (incomplete writes)
 *
 * Never throws — the admin surface must stay readable even if a single row
 * is malformed.
 */
export async function readSponsorLedgerRows(env: Env): Promise<SponsorLedgerRow[]> {
  const kv = statsKV(env);
  const entries = await kv.listWithValues(SPONSOR_LEDGER_PREFIX);
  const out: SponsorLedgerRow[] = [];
  for (const entry of entries) {
    let parsed: SponsorLedgerRow;
    try {
      parsed = JSON.parse(entry.value) as SponsorLedgerRow;
    } catch {
      continue;
    }
    if (!parsed || parsed.kind !== "sponsor" || !parsed.ledger_id) continue;
    out.push(parsed);
  }
  return out;
}

/**
 * GET /v1/admin/sponsor-ledger
 *
 * Query params (all optional):
 *   agent_id=<string>  — filter to one agent
 *   since=<unix_ms>    — filter rows with created_at_ms > since
 *   limit=<int>        — cap response (default 100, max 1000)
 *
 * Returns the most-recent matching rows first (sorted by created_at_ms desc).
 */
adminRoutes.get("/admin/sponsor-ledger", async (c) => {
  if (!isAdmin(c)) {
    return c.json({ error: "unauthorized" }, 401);
  }

  const agentIdFilter = c.req.query("agent_id")?.trim() || undefined;
  const sinceFilter = parsePositiveInt(c.req.query("since"));
  const limitRaw = parsePositiveInt(c.req.query("limit"));
  const limit = limitRaw === undefined
    ? DEFAULT_LIMIT
    : Math.max(1, Math.min(limitRaw, MAX_LIMIT));

  const parsedRows = await readSponsorLedgerRows(c.env);
  const rows: SponsorLedgerResponseRow[] = [];
  for (const parsed of parsedRows) {
    if (agentIdFilter && parsed.agent_id !== agentIdFilter) continue;
    const row = toResponseRow(parsed);
    if (sinceFilter !== undefined && row.created_at_ms <= sinceFilter) continue;
    rows.push(row);
  }

  // Most-recent first.
  rows.sort((a, b) => b.created_at_ms - a.created_at_ms);
  const capped = rows.slice(0, limit);

  return c.json({
    rows: capped,
    count: capped.length,
    filter_applied: {
      ...(agentIdFilter ? { agent_id: agentIdFilter } : {}),
      ...(sinceFilter !== undefined ? { since: sinceFilter } : {}),
      limit,
    },
  });
});

/**
 * GET /v1/analytics/payments  (Day-6 Dominion, plan P5.1)
 *
 * Returns the canonical analytics-payments shape from the v6.16 routing plan.
 * Fields fall into two buckets today:
 *
 *  INSTRUMENTED (real values from `sponsor:ledger:*`):
 *    - sponsor_settled_usd_24h  — sum of sponsor `amount_uc` in last 24h
 *    - sponsor_recouped_usd_24h — 10% of sponsor settled on Flex-rail rows
 *      (rows whose `payment_method === "flex"`). Day-6 Worker-1 will start
 *      writing this field; until then this stays at "0.00" because legacy
 *      rows don't carry a payment_method, which is correct — pre-Flex
 *      payments had no recoup mechanism.
 *
 *  NOT-YET-INSTRUMENTED (returns "0.00" / 0 with a TODO note):
 *    - platform_cut_usd_24h    — requires a `settlement:ledger:*` we don't write
 *    - platform_cut_usd_30d    — same
 *    - creator_payouts_usd_24h — same; non-sponsor settlements aren't logged yet
 *    - flex_escrows_active     — requires facilitator hold-manager snapshot API
 *    - flex_pending_settlements — same
 *    - flex_holds_in_memory    — same
 *
 * The `_partial: true` flag + `_instrumented_fields` array let callers tell
 * which numbers are honest. This is the right tradeoff vs (a) faking numbers
 * or (b) hiding the endpoint until v6.17 ships the settlement ledger.
 */
adminRoutes.get("/analytics/payments", async (c) => {
  if (!isAdmin(c)) {
    return c.json({ error: "unauthorized" }, 401);
  }

  const now = Date.now();
  const day = 24 * 60 * 60 * 1000;
  // Read all sponsor rows; filter to 24h window in-memory. (KV listWithValues
  // is zero-fetch on the LocalKV / PgKV paths used in prod, so the row count
  // is bounded by sponsor activity, not by listing cost.)
  const all = await readSponsorLedgerRows(c.env);
  const sponsor24h = all.filter((row) => {
    const ms = Date.parse(row.settled_at);
    return Number.isFinite(ms) && ms >= now - day;
  });

  // µ¢ → USD: divide by 1_000_000 (USDC has 6 decimals, µ¢ map 1:1).
  const sponsorSettled24hUc = sponsor24h.reduce(
    (sum, r) => sum + (Number.isFinite(r.amount_uc) ? r.amount_uc : 0),
    0,
  );
  // Recoup is 10% of sponsor settled WHERE the payment_method is the Flex
  // rail (the rail that physically supports recouping via escrow flush).
  // Direct-pay legacy rows (no payment_method, or "direct") carry no recoup.
  const sponsorRecouped24hUc = sponsor24h
    .filter((r) => r.payment_method === "flex")
    .reduce(
      (sum, r) => sum + Math.floor((Number.isFinite(r.amount_uc) ? r.amount_uc : 0) * 0.1),
      0,
    );

  const ucToUsd = (uc: number): string => (uc / 1_000_000).toFixed(2);

  return c.json({
    platform_cut_usd_24h: "0.00",
    platform_cut_usd_30d: "0.00",
    sponsor_settled_usd_24h: ucToUsd(sponsorSettled24hUc),
    sponsor_recouped_usd_24h: ucToUsd(sponsorRecouped24hUc),
    creator_payouts_usd_24h: "0.00",
    flex_escrows_active: 0,
    flex_pending_settlements: 0,
    flex_holds_in_memory: 0,
    _partial: true,
    _instrumented_fields: ["sponsor_settled_usd_24h", "sponsor_recouped_usd_24h"],
    _todo:
      "platform_cut/creator_payouts pending settlement-ledger (v6.17); facilitator state pending hold-manager-snapshot integration",
  });
});
