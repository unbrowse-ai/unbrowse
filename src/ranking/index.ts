/**
 * src/ranking/index.ts — server-first ranking dispatcher (P1 + WAVE 2).
 *
 * This is the address all rank callers import from. Two surfaces:
 *
 *   1. `rankEndpoints` (sync) — the LOCAL ranker, re-exported from
 *      `src/execution/index.ts`. It is now the DEGRADED LOCAL FALLBACK:
 *      lower quality (no server learning/retuning), but always available
 *      so an offline resolve never hard-fails. All synchronous internal
 *      call sites keep using it unchanged.
 *
 *   2. `rankEndpointsServerFirst` (async) — WAVE 2 server-move. The
 *      ranking *intelligence* (which captured endpoint best matches an
 *      intent, with what evidence) used to run entirely client-side, so
 *      the tuning weights shipped in the npm bundle and were
 *      reverse-engineerable. This calls the backend rank route
 *      (/v1/search/rank), which computes the same evidence-derived
 *      generic signals (BM25 + URL/schema/host/shape + noise-filter +
 *      freshness) SERVER-side and returns ranked candidates + per-signal
 *      evidence. The calling agent's LLM still judges ties from the
 *      evidence — no second LLM is baked server-side. On any backend
 *      failure it transparently falls back to the local `rankEndpoints`.
 *
 * The agent-facing resolve shortlist (orchestrator buildDeferral) calls
 * the async surface so the intelligence lives server-side; the client
 * bundle no longer carries the authoritative ranking weights.
 *
 * Migration history: Wave 1 was a re-export shim; Wave 2 (this file)
 * adds the server-first path; Wave 3+ extracts the remaining inline
 * scoring deltas into `src/ranking/signals/*.ts` (see PAPER_PLAN.md §P1).
 */

import { rankEndpoints, type RankedEndpoint } from "../execution/index.js";
import type { EndpointDescriptor } from "../types/skill.js";
import { rankEndpointsRemote } from "../client/index.js";

export { rankEndpoints } from "../execution/index.js";
export type { RankedEndpoint } from "../execution/index.js";

/**
 * Server-first endpoint ranking. Tries the backend rank route; on any
 * failure (offline, non-2xx, degraded, local-only, empty) falls back to
 * the local `rankEndpoints` so resolve never hard-fails. x402
 * payment-required errors propagate (the caller decides whether to pay).
 *
 * When the server responds, server scores are mapped back onto the local
 * `RankedEndpoint[]` shape so downstream consumers (deferral, workflow
 * DAG re-order) are unchanged. Endpoints the server dropped (noise
 * filter) are excluded; if the server returned nothing usable the local
 * ranker is authoritative.
 */
export async function rankEndpointsServerFirst(
  endpoints: EndpointDescriptor[],
  intent?: string,
  skillDomain?: string,
  contextUrl?: string,
  params?: Record<string, unknown>,
): Promise<RankedEndpoint[]> {
  const local = (): RankedEndpoint[] =>
    rankEndpoints(endpoints, intent, skillDomain, contextUrl, params);

  if (!Array.isArray(endpoints) || endpoints.length === 0) return local();

  // rankEndpointsRemote returns null on every non-x402 failure and only
  // throws on x402 payment-required (which it re-raises by contract);
  // letting that propagate lets the caller settle and retry.
  const remote = await rankEndpointsRemote(
    intent,
    endpoints as unknown as Array<Record<string, unknown>>,
    skillDomain,
    contextUrl,
  );

  if (!remote || remote.length === 0) return local();

  const byId = new Map(endpoints.map((e) => [e.endpoint_id, e] as const));
  const ranked: RankedEndpoint[] = [];
  for (const r of remote) {
    const ep = byId.get(r.endpoint_id);
    if (ep) ranked.push({ endpoint: ep, score: r.score });
  }
  // Server is authoritative for membership + order when it returns a
  // usable shortlist; otherwise the local ranker decides.
  if (ranked.length > 0) return ranked;
  return local();
}
