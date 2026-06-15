/**
 * energy-ledger — the durable "what-worked" ranking ledger, EmergentDB-first.
 *
 * The ranking energy's layer-1 history (foldLedgerRows/setLedgerIndex, shipped) needs a store that
 * survives ephemeral workers. This holds it as ONE KV value (read = one get, write = one upsert) via
 * the single emergent-first adapter, so it is durable + shared and decided by the SAME priority
 * authority as every other durable store (the consistency directive). Distinct namespace/key from
 * the value-resolution rows. Rows are non-secret ({domain,endpoint,source,outcome}). Fail-closed: no
 * durable creds → energyLedgerFromEnv returns null and the caller keeps the local fs/NEUTRAL path.
 */
import {
  foldLedgerRows, type LedgerIndex, type LedgerRow,
} from "../lib/ranking-core/signals/ledger-energy.js";
import { emergentFirstKV, type DurableKV } from "./emergent-first-tier.js";

/** The one KV value holding the energy history. v1 = a single capped JSON array of rows. */
export const ENERGY_LEDGER_KEY = "unbrowse:energy-ledger:routes:v1";
/** Cap so the single value stays small enough for one fast get (oldest rows compacted out on write). */
const MAX_ROWS = 5000;

/** One execution outcome — the unit appended to the durable ledger. Non-secret by construction. */
export interface ExecutionOutcomeRow {
  domain: string;
  endpoint_id: string;
  source: string;
  outcome: "success" | "failure";
}

export interface EnergyLedgerClient {
  readonly source: string;
  read(): Promise<LedgerRow[]>;
  /** Read-modify-write upsert of the capped row list. Fire-and-forget at the call site. */
  append(row: ExecutionOutcomeRow): Promise<boolean>;
}

function parseRows(raw: string | null): LedgerRow[] {
  if (!raw) return [];
  try {
    const arr = JSON.parse(raw) as unknown;
    return Array.isArray(arr) ? (arr as LedgerRow[]) : [];
  } catch {
    return [];
  }
}

/** Build the energy ledger over a given durable KV (the testable seam). */
export function energyLedgerOverKV(kv: DurableKV): EnergyLedgerClient {
  return {
    source: kv.source,
    async read() {
      return parseRows(await kv.get(ENERGY_LEDGER_KEY));
    },
    async append(row) {
      const rows = parseRows(await kv.get(ENERGY_LEDGER_KEY));
      rows.push(row);
      const capped = rows.length > MAX_ROWS ? rows.slice(rows.length - MAX_ROWS) : rows;
      return kv.set(ENERGY_LEDGER_KEY, JSON.stringify(capped));
    },
  };
}

/**
 * The durable energy ledger via the emergent-first adapter, or null when nothing durable is
 * configured (caller keeps local fs / NEUTRAL). EmergentDB is selected first whenever present.
 */
export function energyLedgerFromEnv(
  env: Record<string, string | undefined> = process.env,
): EnergyLedgerClient | null {
  const kv = emergentFirstKV(env);
  return kv ? energyLedgerOverKV(kv) : null;
}

/** Read the durable rows and fold them into the ranking index (store-agnostic seam, shipped). */
export async function loadDurableLedgerIndex(client: EnergyLedgerClient): Promise<LedgerIndex> {
  return foldLedgerRows(await client.read());
}
