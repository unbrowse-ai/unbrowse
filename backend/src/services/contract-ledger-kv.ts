/**
 * KV-backed ContractLedger implementation — wave 2b of the substrate-server
 * refactor. Replaces `ephemeralLedger()` (per-request in-memory) with
 * `statsKV(env)`-backed durable storage. Keys:
 *
 *   contract:<id>:event:<ts>:<seq-hash>   → JSON-encoded ContractEventRow
 *   wallet:<pubkey>:row:<ts>:<id>         → contract id (back-index for
 *                                           per-wallet listing — used by
 *                                           the attestation gate's audit
 *                                           surface, not yet by routes)
 *
 * Append-only: every write picks a unique `event:<ts>:<random>` suffix so
 * KV's last-write-wins semantics never coalesce two distinct events for
 * the same contract. Reads aggregate all `contract:<id>:event:*` keys
 * via the KV prefix-scan + values-inline pattern already used by
 * sponsor/skill ledgers (`statsKV.listWithValues`).
 *
 * Per CLAUDE.md "Never mock in tests": the test path uses ENVIRONMENT="local-dev"
 * which makes `statsKV()` return a `LocalKV` instance backed by an in-process
 * `Map`. Same interface, same code path — no mocks of the KV surface.
 */

import { statsKV } from "./kv.js";
import type {
  ContractEventRow,
  ContractLedger,
} from "./contract-ledger.js";

/**
 * Minimal env shape statsKV needs. Mirrors KVEnv in `kv.ts` so this
 * module doesn't depend on the full backend `Env` (which doesn't
 * declare USE_PGKV anyway — it's read off process.env in the gate).
 */
export interface KvLedgerEnv {
  ENVIRONMENT?: string;
  DATABASE_URL?: string;
  EMERGENTDB_API_KEY?: string;
  EMERGENTDB_MAX_VALUE_BYTES?: string;
  USE_PGKV?: string;
}

/** A short random hex suffix so two writes within the same millisecond don't collide. */
function randomSuffix(): string {
  const bytes = new Uint8Array(4);
  crypto.getRandomValues(bytes);
  return Array.from(bytes).map((b) => b.toString(16).padStart(2, "0")).join("");
}

/**
 * KV-backed ContractLedger. `listAll` / `listChildren` scan the
 * `contract:` prefix; the index is bounded by the number of events
 * appended, which for a single contract is on the order of waves × 1
 * row. The substrate-server runtime is the bottleneck on growth here,
 * not KV.
 */
export function kvLedger(env: KvLedgerEnv): ContractLedger {
  const kv = statsKV(env);
  return {
    async append(row) {
      const ts = row.ts || new Date().toISOString();
      const stamped: ContractEventRow = { ...row, ts };
      const key = `contract:${row.id}:event:${ts}:${randomSuffix()}`;
      await kv.put(key, JSON.stringify(stamped));
      // Back-index by wallet so a future audit surface can enumerate
      // every row signed by a given pubkey without scanning the whole
      // contract: namespace.
      const writer = stamped.wallet_identity ?? stamped.agent;
      if (writer) {
        await kv.put(
          `wallet:${writer}:row:${ts}:${row.id}`,
          row.id,
        );
      }
      return stamped;
    },
    async get(id) {
      const entries = await kv.listWithValues(`contract:${id}:event:`);
      if (entries.length === 0) return null;
      const rows = entries
        .map((e) => safeParse<ContractEventRow>(e.value))
        .filter((r): r is ContractEventRow => r !== null);
      // Order chronologically by ts to keep status projection deterministic.
      rows.sort((a, b) => (a.ts ?? "").localeCompare(b.ts ?? ""));
      return rows.length > 0 ? rows : null;
    },
    async listAll(opts) {
      const entries = await kv.listWithValues(`contract:`);
      const rows = entries
        .map((e) => safeParse<ContractEventRow>(e.value))
        .filter((r): r is ContractEventRow => r !== null);
      rows.sort((a, b) => (a.ts ?? "").localeCompare(b.ts ?? ""));
      if (opts?.showMerged === false) {
        const merged = new Set(rows.filter((r) => r.event === "merged").map((r) => r.id));
        return rows.filter((r) => !merged.has(r.id));
      }
      return rows;
    },
    async listChildren(parentId) {
      const all = await this.listAll();
      return all.filter((r) => r.parent_id === parentId);
    },
  };
}

function safeParse<T>(s: string): T | null {
  try {
    return JSON.parse(s) as T;
  } catch {
    return null;
  }
}
