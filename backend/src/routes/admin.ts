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
 * TODO(v6.16): wire sponsor_settled_usd_24h into /v1/analytics/payments when
 * that route exists. Compute from the same ledger prefix used here
 * (`sponsor:ledger:*`, filter rows where
 * `Date.parse(settled_at) > now - 86_400_000`). Tracked at D3 in the
 * Skill-Sunset / Sponsor-Tier plan.
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

  const kv = statsKV(c.env);
  const entries = await kv.listWithValues(SPONSOR_LEDGER_PREFIX);

  const rows: SponsorLedgerResponseRow[] = [];
  for (const entry of entries) {
    let parsed: SponsorLedgerRow;
    try {
      parsed = JSON.parse(entry.value) as SponsorLedgerRow;
    } catch {
      // Skip corrupted rows but never throw — admin surface must stay readable.
      continue;
    }
    if (!parsed || parsed.kind !== "sponsor" || !parsed.ledger_id) continue;
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
