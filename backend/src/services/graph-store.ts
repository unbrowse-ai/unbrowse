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
import { type RouteDelta } from "../../../src/values/route-delta.js";
import { sha256hex } from "../../../src/values/content-address.js";
import type { ContributionLedger, ContributionRecord } from "../routes/contribution.js";
import { emptyLedger } from "../routes/contribution.js";
import { statsKV } from "./kv.js";

/** Per-endpoint key prefixes — one small value per winner / per ledger record, so no value
 *  approaches EmergentDB's qdkv ~10KB cap (a growing whole-graph blob would be truncated). */
export const WINNER_PREFIX = "contrib:w:";
export const LEDGER_PREFIX = "contrib:l:";
/** A winner's key: prefix + sha256 of its endpoint (clean, fixed-length, collision-resistant). */
export const winnerKey = (endpoint: string): string => WINNER_PREFIX + sha256hex(endpoint);
/** A ledger record's key: prefix + zero-padded seq (lexicographically ordered). */
export const ledgerKey = (seq: number): string => LEDGER_PREFIX + String(seq).padStart(12, "0");

/** Minimal KV surface: get/put plus a prefix `list` (EdbKV + CF KVNamespace both provide it). */
export interface GraphKV {
  get(key: string, type: "json"): Promise<unknown>;
  put(key: string, value: string): Promise<void>;
  list(prefix: string): Promise<string[]>;
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

  async list(prefix: string): Promise<string[]> {
    try {
      const keys = await this.primary.list(prefix);
      if (keys.length > 0) return keys;
    } catch {
      /* primary unavailable → fall through */
    }
    try { return await this.fallback.list(prefix); } catch { return []; }
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

/** A raw KV whose `list` returns the Cloudflare/EdbKV shape ({keys:[{name}]}, paginated). */
export interface RawListKV {
  get(key: string, type: "json"): Promise<unknown>;
  put(key: string, value: string, opts?: unknown): Promise<void>;
  list(opts: { prefix: string; limit?: number; cursor?: string }): Promise<{
    keys: { name: string }[];
    list_complete?: boolean;
    cursor?: string;
  }>;
}

/** Adapt a raw CF/EdbKV/FallbackKV store to the GraphKV interface: normalise its paginated
 *  `list({prefix})` into a flat `string[]` of key names (EdbKV and CF KVNamespace share the
 *  shape; FallbackKV layers EmergentDB→CF over it). */
export function adaptKV(raw: RawListKV): GraphKV {
  return {
    get: (k, t) => raw.get(k, t),
    put: (k, v) => raw.put(k, v),
    list: async (prefix: string): Promise<string[]> => {
      const names: string[] = [];
      let cursor: string | undefined;
      do {
        const r = await raw.list({ prefix, cursor });
        for (const e of r.keys) names.push(e.name);
        cursor = r.list_complete === false ? r.cursor : undefined;
      } while (cursor);
      return names;
    },
  };
}

/** Resolve the production graph store: EmergentDB-backed FallbackKV (EmergentDB primary, CF
 *  KV fallback) when an EmergentDB store is available, else the dedicated CF GRAPH_KV +
 *  STATS_KV fallback, else shared STATS_KV, else none. `emergent` is injectable for tests; in
 *  production it is built from the EmergentDB-backed `statsKV` via `buildEmergentGraphKV`. */
export function makeGraphKV(
  env: { GRAPH_KV?: RawListKV; STATS_KV?: RawListKV },
  deps: { emergent?: GraphKV | null },
): { kv: GraphKV | null; tier: "emergentdb" | "emergentdb+cf" | "dedicated-fallback" | "shared" | "none" } {
  const graph = env.GRAPH_KV ? adaptKV(env.GRAPH_KV) : undefined;
  const stats = env.STATS_KV ? adaptKV(env.STATS_KV) : undefined;
  // The CF tier (dedicated GRAPH_KV primary + STATS_KV fallback) — the resilient floor.
  const cf = resolveGraphStore({ GRAPH_KV: graph, STATS_KV: stats }).kv;

  if (deps.emergent) {
    // EmergentDB primary; if a CF store exists, wrap so an EmergentDB error/miss degrades to
    // CF and writes mirror to it (an EmergentDB outage never 500s the route).
    if (cf) return { kv: new FallbackGraphKV(deps.emergent, cf), tier: "emergentdb+cf" };
    return { kv: deps.emergent, tier: "emergentdb" };
  }
  if (cf) {
    const mode = graph ? "dedicated-fallback" : "shared";
    return { kv: cf, tier: mode };
  }
  return { kv: null, tier: "none" };
}

/** Build the EmergentDB-backed graph store (EmergentDB primary + CF STATS_KV fallback) from
 *  the backend's `statsKV` (a FallbackKV), or null when EmergentDB is not configured (no key
 *  and not local-dev) — the caller then falls back to the dedicated CF GRAPH_KV. */
export function buildEmergentGraphKV(env: {
  EMERGENTDB_API_KEY?: string;
  ENVIRONMENT?: string;
  STATS_KV?: unknown;
}): GraphKV | null {
  const keyed = !!env.EMERGENTDB_API_KEY?.trim();
  if (!keyed && env.ENVIRONMENT !== "local-dev") return null;
  try {
    return adaptKV(statsKV(env as Parameters<typeof statsKV>[0]) as unknown as RawListKV);
  } catch {
    return null;
  }
}

/** Load one endpoint's current winning delta (null if none). One get; the O(1) read the
 *  per-endpoint merge needs. */
export async function loadWinner(kv: GraphKV, endpoint: string): Promise<RouteDelta | null> {
  return (await kv.get(winnerKey(endpoint), "json")) as RouteDelta | null;
}

/** Persist one winning delta under its own key (~500 B — never near the qdkv cap). */
export async function saveWinner(kv: GraphKV, delta: RouteDelta): Promise<void> {
  await kv.put(winnerKey(delta.endpoint), JSON.stringify(delta));
}

/** A loaded value is only a usable winner if it is a fully-formed signed delta. Legacy or
 *  truncated entries (e.g. an EmergentDB-truncated index value missing `sig`) are skipped
 *  rather than fed to deltaId/graphRoot, where `Buffer.from(undefined)` would throw. */
function isWellFormedDelta(d: unknown): d is RouteDelta {
  const r = d as Record<string, unknown> | null;
  return !!r
    && typeof r.endpoint === "string"
    && typeof r.sig === "string"
    && typeof r.walletRoot === "string"
    && typeof r.shape === "string"
    && typeof r.prev === "string"
    && typeof r.op === "string"
    && typeof r.freshness === "number"
    && typeof r.seq === "number";
}

/** Load the whole shared graph by enumerating per-endpoint winner keys. Malformed/legacy
 *  values are skipped defensively (schema-evolution + truncation resilience). */
export async function loadGraph(kv: GraphKV): Promise<SharedGraph> {
  const g = emptyGraph();
  const keys = await kv.list(WINNER_PREFIX);
  for (const k of keys) {
    let d: unknown = null;
    try { d = await kv.get(k, "json"); } catch { continue; }
    if (isWellFormedDelta(d)) g.winners.set(d.endpoint, d);
  }
  return g;
}

/** Persist every winner of an in-memory graph as its own key (compat for whole-graph saves;
 *  the route uses saveWinner for the single admitted endpoint). */
export async function saveGraph(kv: GraphKV, g: SharedGraph): Promise<void> {
  for (const delta of g.winners.values()) await saveWinner(kv, delta);
}

/** Append one ledger record under its own key. */
export async function appendLedgerRecord(kv: GraphKV, rec: ContributionRecord): Promise<void> {
  await kv.put(ledgerKey(rec.seq), JSON.stringify(rec));
}

/** Load the contribution ledger by enumerating per-record keys (ordered by seq). */
export async function loadLedger(kv: GraphKV): Promise<ContributionLedger> {
  const l = emptyLedger();
  const keys = await kv.list(LEDGER_PREFIX);
  const recs: ContributionRecord[] = [];
  for (const k of keys) {
    let r: unknown = null;
    try { r = await kv.get(k, "json"); } catch { continue; }
    const rec = r as ContributionRecord | null;
    if (rec && typeof rec.seq === "number" && typeof rec.endpoint === "string") recs.push(rec);
  }
  recs.sort((a, b) => a.seq - b.seq);
  l.records.push(...recs);
  return l;
}

/** Persist every ledger record as its own key (compat; the route appends one at a time). */
export async function saveLedger(kv: GraphKV, l: ContributionLedger): Promise<void> {
  for (const rec of l.records) await appendLedgerRecord(kv, rec);
}

/** Next ledger seq = current record count (enumerated). */
export async function ledgerNextSeq(kv: GraphKV): Promise<number> {
  return (await kv.list(LEDGER_PREFIX)).length;
}
