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
import {
  aggregateUnsettled,
  executeSettlement,
  persistBatch,
  readBatch,
} from "../services/settlement.js";

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
  const month = 30 * day;
  // Read all sponsor rows; filter to 24h / 30d windows in-memory. (KV
  // listWithValues is zero-fetch on the LocalKV / PgKV paths used in prod, so
  // the row count is bounded by sponsor activity, not by listing cost.)
  const all = await readSponsorLedgerRows(c.env);
  const sponsor24h = all.filter((row) => {
    const ms = Date.parse(row.settled_at);
    return Number.isFinite(ms) && ms >= now - day;
  });
  const sponsor30d = all.filter((row) => {
    const ms = Date.parse(row.settled_at);
    return Number.isFinite(ms) && ms >= now - month;
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

  // ─── contract b21e7d7e: real platform_cut + creator_payouts ────────────
  //
  // Each settled sponsor:ledger row represents a paid execute. The platform
  // cut is `amount_uc * effective_platform_bps / 10000` for that row; when
  // a row doesn't carry `effective_platform_bps` (the v6.16 default writer
  // doesn't), we fall back to PLATFORM_BPS (5000 = 50%) per
  // docs/HOW_UNBROWSE_PAYS.md. The creator + owner + contributors share the
  // remainder.
  //
  // SponsorLedgerRow is treated structurally — we read `effective_platform_bps`
  // as an optional extension that future writers can stamp.
  type RowWithBps = (typeof sponsor24h)[number] & {
    effective_platform_bps?: number;
  };
  const DEFAULT_PLATFORM_BPS = 5000;
  function platformCutUc(rows: RowWithBps[]): number {
    return rows.reduce((sum, r) => {
      const amount = Number.isFinite(r.amount_uc) ? r.amount_uc : 0;
      const bps = typeof r.effective_platform_bps === "number"
        && Number.isFinite(r.effective_platform_bps)
        && r.effective_platform_bps >= 0
        && r.effective_platform_bps <= 10000
        ? r.effective_platform_bps
        : DEFAULT_PLATFORM_BPS;
      return sum + Math.floor((amount * bps) / 10000);
    }, 0);
  }

  const platformCut24hUc = platformCutUc(sponsor24h as RowWithBps[]);
  const platformCut30dUc = platformCutUc(sponsor30d as RowWithBps[]);
  // Creator payouts = total settled minus the platform cut (the creator +
  // owner + contributors share that remainder). For 24h only — the plan
  // hardcodes the 24h window for creator_payouts.
  const creatorPayouts24hUc = sponsorSettled24hUc - platformCut24hUc;

  const ucToUsd = (uc: number): string => (uc / 1_000_000).toFixed(2);

  return c.json({
    platform_cut_usd_24h: ucToUsd(platformCut24hUc),
    platform_cut_usd_30d: ucToUsd(platformCut30dUc),
    sponsor_settled_usd_24h: ucToUsd(sponsorSettled24hUc),
    sponsor_recouped_usd_24h: ucToUsd(sponsorRecouped24hUc),
    creator_payouts_usd_24h: ucToUsd(Math.max(0, creatorPayouts24hUc)),
    flex_escrows_active: 0,
    flex_pending_settlements: 0,
    flex_holds_in_memory: 0,
    _partial: true,
    _instrumented_fields: [
      "platform_cut_usd_24h",
      "platform_cut_usd_30d",
      "sponsor_settled_usd_24h",
      "sponsor_recouped_usd_24h",
      "creator_payouts_usd_24h",
    ],
    _todo:
      "flex_escrows_active / flex_pending_settlements / flex_holds_in_memory pending facilitator hold-manager-snapshot integration",
  });
});

/**
 * POST /v1/admin/aggregate-settlement?since=&until=&dry_run= — contract b21e7d7e.
 *
 * Walks unsettled `sponsor:ledger:*` rows in the optional time window, groups
 * them via `aggregateUnsettled`, persists the resulting pending batch under
 * `settlement:ledger:<id>` via `persistBatch`, and returns the batch shape.
 * When `dry_run=1` the batch is still persisted (it is the source-of-truth for
 * `POST /v1/admin/execute-settlement` to read from), but the caller can see
 * exactly what would be settled before executing.
 *
 * Query params (all optional):
 *   since=<unix_ms>      — inclusive lower bound on row settled_at
 *   until=<unix_ms>      — exclusive upper bound on row settled_at
 *   dry_run=1            — informational; the route still persists the batch
 */
adminRoutes.post("/admin/aggregate-settlement", async (c) => {
  if (!isAdmin(c)) {
    return c.json({ error: "unauthorized" }, 401);
  }
  const since = parsePositiveInt(c.req.query("since"));
  const until = parsePositiveInt(c.req.query("until"));
  const dryRun = c.req.query("dry_run") === "1" || c.req.query("dry_run") === "true";

  const filter: { since?: number; until?: number } = {};
  if (since !== undefined) filter.since = since;
  if (until !== undefined) filter.until = until;

  const batch = await aggregateUnsettled(c.env, filter);
  await persistBatch(c.env, batch);
  return c.json({ batch, dry_run: dryRun });
});

/**
 * POST /v1/admin/execute-settlement — contract b21e7d7e.
 *
 * Body: `{ batch_id: string, dry_run?: boolean }`.
 *
 * Reads the batch from KV (must exist; pending status only — already-executed
 * batches return the prior receipt unchanged), builds the FlexAuthorization,
 * and on `dry_run` returns the auth shape + projected splits WITHOUT submitting
 * any Solana RPC. On live, signs+submits via `sendSponsorFlexPayment` and
 * stamps each source row with `batch_settled_tx` so it does not replay.
 */
adminRoutes.post("/admin/execute-settlement", async (c) => {
  if (!isAdmin(c)) {
    return c.json({ error: "unauthorized" }, 401);
  }
  let body: { batch_id?: string; dry_run?: boolean };
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: "invalid_json_body" }, 400);
  }
  const batchId = body?.batch_id?.trim();
  if (!batchId) {
    return c.json({ error: "batch_id_required" }, 400);
  }
  const dryRun = body.dry_run === true;
  try {
    const result = await executeSettlement(c.env, batchId, { dry_run: dryRun });
    return c.json(result);
  } catch (err) {
    return c.json({ error: (err as Error).message }, 404);
  }
});

/**
 * GET /v1/admin/settlement/:batch_id — contract b21e7d7e.
 *
 * Returns the persisted SettlementBatch row, or 404 when absent.
 */
adminRoutes.get("/admin/settlement/:batch_id", async (c) => {
  if (!isAdmin(c)) {
    return c.json({ error: "unauthorized" }, 401);
  }
  const batchId = c.req.param("batch_id")?.trim();
  if (!batchId) {
    return c.json({ error: "batch_id_required" }, 400);
  }
  const batch = await readBatch(c.env, batchId);
  if (!batch) {
    return c.json({ error: "batch_not_found", batch_id: batchId }, 404);
  }
  return c.json({ batch });
});
