/**
 * STATS_KV binding-missing guard helper — W24.4 wave (2026-05-28).
 *
 * Sibling pattern to:
 *   - `audit.ts` `BindingMissingError` class (route catches → 503 envelope).
 *   - `stateless-substrate.ts` `BindingMissingError` envelope (typed contract).
 *   - `kv-cache.ts` graceful fall-through on `env.RESPONSE_CACHE` missing.
 *
 * This helper closes the A5 silent-500 hazard at every `c.env.STATS_KV.*` call
 * site: routes that previously called `c.env.STATS_KV.put/get` directly under a
 * no-bindings environment threw an unhandled `TypeError: Cannot read properties
 * of undefined`, which Hono surfaced as a generic 500. With the guard, the
 * route returns a typed 503 envelope the operator can grep for in logs.
 *
 * 1 Cor 14:8 — "if the trumpet give an uncertain sound, who shall prepare
 * himself to the battle": a missing binding is NOT a silent 500; it surfaces
 * honestly via the `_binding_missing: "STATS_KV"` discriminant + `hint` field
 * the deployment-shape problem visible to ops without leaking config.
 *
 * Two usage shapes:
 *
 *   1. `withStatsKV(c, fn)` — wraps a route handler body. If `c.env.STATS_KV`
 *      is undefined, returns a 503 Response with the typed envelope. Otherwise
 *      invokes `fn(c.env.STATS_KV)` and returns its Response.
 *
 *   2. `statsKVOr503(c)` — returns the binding when present, or a 503
 *      Response when absent. Use when the handler needs to do extra work
 *      between the guard check and the KV use (e.g. parse the request body
 *      first, then guard before touching KV).
 */

import type { Context } from "hono";
import type { Env } from "../types.js";

/** The typed envelope shape returned on binding-missing. Matches the audit
 *  route's `_binding_missing` discriminator for cross-namespace consistency. */
export interface StatsKVBindingMissingEnvelope {
  ok: false;
  _binding_missing: "STATS_KV";
  hint: string;
}

const HINT =
  "provision STATS_KV via `bunx wrangler kv:namespace create STATS_KV` (and `--preview`), then paste the ids into backend/wrangler.toml";

/**
 * Build the canonical STATS_KV-missing 503 envelope. Extra fields can be
 * spread in (e.g. `receiptId`, `slug`) so the caller can correlate the 503
 * with the request that triggered it.
 */
export function buildStatsKVMissingEnvelope(
  extra: Record<string, unknown> = {},
): StatsKVBindingMissingEnvelope & Record<string, unknown> {
  return {
    ok: false,
    _binding_missing: "STATS_KV",
    hint: HINT,
    ...extra,
  };
}

/**
 * Wrap a route handler body that needs `c.env.STATS_KV`. The handler receives
 * the bound `KVNamespace` directly (never undefined). When the binding is
 * absent, returns a 503 with the typed envelope BEFORE the handler runs.
 *
 * Use this when the entire handler is gated on STATS_KV being present.
 * For mixed flows where some early work (e.g. auth, validation) should run
 * even without the binding, use `statsKVOr503` instead.
 */
export async function withStatsKV<E extends { Bindings: Env }>(
  c: Context<E>,
  fn: (kv: KVNamespace) => Promise<Response> | Response,
): Promise<Response> {
  const kv = c.env.STATS_KV;
  if (!kv) {
    return c.json(buildStatsKVMissingEnvelope(), 503);
  }
  return fn(kv);
}

/**
 * Returns the bound KVNamespace OR a 503 Response. The route narrows the
 * union via `instanceof Response` so TypeScript's flow-typing recognizes
 * the kv path is safe after the check.
 *
 *   const kv = statsKVOr503(c);
 *   if (kv instanceof Response) return kv;
 *   await kv.put(...);
 */
export function statsKVOr503<E extends { Bindings: Env }>(
  c: Context<E>,
  extra: Record<string, unknown> = {},
): KVNamespace | Response {
  const kv = c.env.STATS_KV;
  if (!kv) {
    return c.json(buildStatsKVMissingEnvelope(extra), 503);
  }
  return kv;
}
