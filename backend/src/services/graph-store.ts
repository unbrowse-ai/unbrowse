/**
 * graph-store — KV persistence for the ZK-gated shared route graph + contribution
 * ledger (deploy wiring for plan nodes 4-5). Cloudflare Workers are stateless per
 * request, so the in-memory SharedGraph / ContributionLedger are loaded from and saved
 * to KV around each admit. "Value off-chain, root on-chain": the winners + ledger live
 * in KV; the Merkle root is the small commitment a chain checkpoint would publish (the
 * on-chain anchor is the next deploy step). A missing KV binding is honest-fail (the
 * caller returns a 503 envelope), never a silent in-memory graph that vanishes.
 */
import type { SharedGraph } from "./graph-merge/index.js";
import { emptyGraph } from "./graph-merge/index.js";
import type { RouteDelta } from "../../../src/values/route-delta.js";
import type { ContributionLedger, ContributionRecord } from "../routes/contribution.js";
import { emptyLedger } from "../routes/contribution.js";

/** Key prefix isolates the shared graph from any other data in a shared namespace. */
export const GRAPH_KEY = "contrib:graph:v1";
export const LEDGER_KEY = "contrib:ledger:v1";

/** Minimal KV surface we need (matches Cloudflare KVNamespace). */
export interface GraphKV {
  get(key: string, type: "json"): Promise<unknown>;
  put(key: string, value: string): Promise<void>;
}

/** Resolve where the shared graph lives. A DEDICATED `GRAPH_KV` namespace is preferred
 *  (fully isolated from analytics); absent that, STATS_KV under the `contrib:` key prefix
 *  is the fallback (key-isolated within a shared namespace); absent both, honest-null. The
 *  `dedicated` flag lets the caller surface which store served the request. */
export function resolveGraphKV(env: { GRAPH_KV?: GraphKV; STATS_KV?: GraphKV }): {
  kv: GraphKV | null;
  dedicated: boolean;
} {
  if (env.GRAPH_KV) return { kv: env.GRAPH_KV, dedicated: true };
  if (env.STATS_KV) return { kv: env.STATS_KV, dedicated: false };
  return { kv: null, dedicated: false };
}

/**
 * A graph store that reads its PRIMARY first and falls back to a SECONDARY on a miss or an
 * error, and mirror-writes to both so the secondary can keep serving if the primary later
 * goes unavailable. The `kv-fallback-pipe` shape (EmergentDB→CF KV) applied to the contribution
 * graph: GRAPH_KV primary, CF STATS_KV fallback — resilient to a primary-store outage.
 */
export class FallbackGraphKV implements GraphKV {
  constructor(private primary: GraphKV, private fallback: GraphKV) {}

  async get(key: string, type: "json"): Promise<unknown> {
    try {
      const v = await this.primary.get(key, type);
      if (v !== null && v !== undefined) return v;
    } catch {
      /* primary unavailable → fall through to the secondary */
    }
    try {
      return await this.fallback.get(key, type);
    } catch {
      return null;
    }
  }

  async put(key: string, value: string): Promise<void> {
    let primaryOk = false;
    try { await this.primary.put(key, value); primaryOk = true; } catch { /* still mirror below */ }
    try {
      await this.fallback.put(key, value);
    } catch {
      if (!primaryOk) throw new Error("graph store: primary and fallback writes both failed");
    }
  }
}

/** Resolve the graph store with runtime fallback: GRAPH_KV primary + CF STATS_KV fallback
 *  when both are bound; dedicated GRAPH_KV alone; shared STATS_KV alone; else honest-null. */
export function resolveGraphStore(env: { GRAPH_KV?: GraphKV; STATS_KV?: GraphKV }): {
  kv: GraphKV | null;
  mode: "fallback" | "dedicated" | "shared" | "none";
} {
  if (env.GRAPH_KV && env.STATS_KV) return { kv: new FallbackGraphKV(env.GRAPH_KV, env.STATS_KV), mode: "fallback" };
  if (env.GRAPH_KV) return { kv: env.GRAPH_KV, mode: "dedicated" };
  if (env.STATS_KV) return { kv: env.STATS_KV, mode: "shared" };
  return { kv: null, mode: "none" };
}

/** Load the shared graph winners from KV (empty if unset). */
export async function loadGraph(kv: GraphKV): Promise<SharedGraph> {
  const raw = (await kv.get(GRAPH_KEY, "json")) as [string, RouteDelta][] | null;
  const g = emptyGraph();
  if (Array.isArray(raw)) for (const [endpoint, delta] of raw) g.winners.set(endpoint, delta);
  return g;
}

/** Persist the shared graph winners to KV (serialised as endpoint→delta pairs). */
export async function saveGraph(kv: GraphKV, g: SharedGraph): Promise<void> {
  await kv.put(GRAPH_KEY, JSON.stringify([...g.winners.entries()]));
}

/** Load the contribution attribution ledger from KV (empty if unset). */
export async function loadLedger(kv: GraphKV): Promise<ContributionLedger> {
  const raw = (await kv.get(LEDGER_KEY, "json")) as ContributionRecord[] | null;
  const l = emptyLedger();
  if (Array.isArray(raw)) l.records.push(...raw);
  return l;
}

/** Persist the contribution attribution ledger to KV. */
export async function saveLedger(kv: GraphKV, l: ContributionLedger): Promise<void> {
  await kv.put(LEDGER_KEY, JSON.stringify(l.records));
}
