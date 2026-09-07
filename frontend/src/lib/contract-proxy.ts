/**
 * contract-proxy — the website is a THIN FRONTEND that PROXIES to the on-chain stuff, with
 * KV + emergentDB + graph on top.
 *
 * The directive: drill it down — make the whole website just a frontend + proxies to the on-chain
 * /contract ledger, with KV / emergentDB / graph as the layered cache on top. The frontend holds
 * NO business logic; every route resolves an intent through the layered contract backing FIRST
 * (KV → emergentDB → graph — a recall, no on-chain round-trip), and only on a FULL MISS fetches
 * the ON-CHAIN SOURCE (the signed contract ledger), back-filling the fastest layer so the next hit
 * is muscle memory. This is the frontend-edge twin of `apiContract` (src/values/api-contract.ts) —
 * the same recall-first/source-on-miss precedence, in the frontend's own deploy.
 *
 * The real KV / emergentDB / graph bindings are supplied by the frontend worker at deploy (the
 * named integration seam); this module defines the PRECEDENCE + the on-chain-source-on-miss, and
 * carries the `_contract` verdict shape on every response.
 */
import { contractVerdictFromEnvelope, type ContractVerdict } from "./contract-shape";

/** A read-through backing layer (KV, emergentDB, graph) — a thin get/put over the contract ledger
 *  mirror. `get` returns the cached value or null; `put` (optional) back-fills. */
export interface LedgerLayer {
  name: string;
  get(key: string): Promise<unknown | null>;
  put?(key: string, value: unknown): Promise<void>;
}

export interface ProxyResult<T> {
  value: T;
  /** true = served from a layer (KV/emergentDB/graph), the on-chain source was NOT hit. */
  recalled: boolean;
  /** which layer served it: a layer name, or "onchain" on a full miss. */
  layer: string;
  _contract: ContractVerdict;
}

/**
 * contractProxy — resolve an `intent` through the layered backing (fastest→slowest), falling to
 * the on-chain `source` only on a full miss. The website becomes a thin proxy: layers on top,
 * the signed ledger underneath.
 */
export async function contractProxy<T>(opts: {
  intent: string;
  /** ordered fastest→slowest: [kv, emergentdb, graph]. */
  layers: LedgerLayer[];
  /** the ON-CHAIN source (the contract ledger), fetched ONLY on a full layer miss. */
  source: () => Promise<T>;
  /** only commit a source result to memory when this holds (default: non-null). Keeps errors live. */
  cacheable?: (v: T) => boolean;
  /** back-fill the fastest layer with a source result so the next hit is muscle memory (default true). */
  backfill?: boolean;
}): Promise<ProxyResult<T>> {
  const key = opts.intent;
  for (const layer of opts.layers) {
    const hit = await layer.get(key);
    if (hit !== null && hit !== undefined) {
      const env = { ok: true, intent: opts.intent, layer: layer.name, recalled: true };
      return { value: hit as T, recalled: true, layer: layer.name, _contract: contractVerdictFromEnvelope(env) };
    }
  }
  // full miss → the ON-CHAIN source (the signed contract ledger)
  const value = await opts.source();
  const committable = opts.cacheable ? opts.cacheable(value) : value != null;
  if (committable && opts.backfill !== false && opts.layers[0]?.put) {
    try {
      await opts.layers[0].put(key, value);
    } catch {
      /* back-fill is best-effort — the value is still returned */
    }
  }
  const env = { ok: true, intent: opts.intent, layer: "onchain", recalled: false };
  return { value, recalled: false, layer: "onchain", _contract: contractVerdictFromEnvelope(env) };
}
