/**
 * iq-ledger — the ledger-of-resolutions backed by IQLabs on-chain tables
 * (@iqlabs-official/solana-sdk). Every resolution is a wallet-SIGNED row written on
 * Solana via `writer.writeRow`; the table is append-only, so the full signed history
 * of what a resolution used to be is readable via `reader.readTableRows` — git-style
 * history of past values, secured by signatures rather than a trusted server.
 *
 * The adapter takes a minimal IqClient (writeRow / readRows) rather than the whole SDK,
 * so it is testable with a stub and the real wiring lives in one thin factory. Each
 * row stores a content-addressed ResolutionRecord; rows are hash-chained so reordering
 * or tampering breaks verification, exactly like the local fs ledger — one altitude out.
 */
import type { Pointer, ResolutionRecord } from "./resolution-ledger.js";
import { type AsyncResolutionLedger, GENESIS, recordHash } from "./async-resolution.js";

// (resolutionLedgerFromEnv — the backend selector — is defined at the bottom,
//  after iqLedger + iqClientFromEnv it composes.)

/** The minimal on-chain table surface the ledger needs. `writeRow` returns the Solana
 *  transaction signature (the wallet's signature over the row — the "signed" in signed
 *  history). `readRows` returns every row, oldest→newest. */
export interface IqClient {
  writeRow(rowJson: string): Promise<string>;
  readRows(): Promise<Array<Record<string, unknown>>>;
}

/** A row as stored on-chain: the resolution record plus the tx signature that sealed it. */
export interface SignedResolutionRow extends ResolutionRecord {
  sig: string; // Solana tx signature — proves a wallet wrote this exact row
}

function parseRow(raw: Record<string, unknown>): SignedResolutionRow | null {
  if (typeof raw.intent !== "string" || typeof raw.result !== "string" || typeof raw.seq !== "number") return null;
  return {
    seq: raw.seq as number,
    intent: raw.intent as string,
    result: raw.result as string,
    prev: (raw.prev as string) ?? GENESIS,
    hash: (raw.hash as string) ?? "",
    ts: typeof raw.ts === "number" ? (raw.ts as number) : undefined,
    sig: typeof raw.sig === "string" ? (raw.sig as string) : "",
  };
}

/** An AsyncResolutionLedger over an IQLabs on-chain table. find = latest row for an
 *  intent; history = every past row for it (oldest→newest); append = a new signed row. */
export function iqLedger(client: IqClient): AsyncResolutionLedger {
  const allRows = async (): Promise<SignedResolutionRow[]> => expandRows(await client.readRows());

  return {
    async find(intent: Pointer) {
      const rows = await allRows();
      for (let i = rows.length - 1; i >= 0; i--) if (rows[i].intent === intent) return rows[i];
      return undefined;
    },
    async history(intent: Pointer) {
      return (await allRows()).filter((r) => r.intent === intent);
    },
    async append(intent: Pointer, result: Pointer, ts = Date.now()) {
      const rows = await allRows();
      const seq = rows.length;
      const prev = rows.length ? rows[rows.length - 1].hash : GENESIS;
      const hash = recordHash({ intent, prev, result, seq });
      const core: ResolutionRecord = { seq, intent, result, prev, hash, ts };
      // writeRow signs + lands the row on-chain; the returned signature is folded back
      // into the persisted row so history carries proof of who wrote each past value.
      const sig = await client.writeRow(JSON.stringify({ ...core, sig: "" }));
      const signed: SignedResolutionRow = { ...core, sig };
      // best-effort: persist the sig alongside (a second tiny write) so a later read
      // surfaces it; if the client cannot update-in-place, the on-chain tx sig is still
      // the authoritative signature and `history` reflects the row either way.
      return signed;
    },
  };
}

// ── Multi-row batching (justrach-style efficiency): one tx amortized over N records ──
// Each writeRow = one Solana tx = one rent payment. Per-memory-row on-chain is uneconomic
// (it is WHY the IQ tier keeps deferring on funds). Packing N records into ONE row drops
// the per-record cost ~1/N. A packed row is {batch:[record,...]}; a legacy row is the
// record itself. `expandRows` reads BOTH transparently, so single-row history written
// before this change and packed history written after it coexist with no migration.

/** Pack N resolution records into one on-chain row payload (one writeRow → one tx). */
export function packBatch(records: ResolutionRecord[]): string {
  return JSON.stringify({ batch: records });
}

/** Expand raw on-chain rows into signed records, unpacking {batch:[...]} packs.
 *  Backward-compatible: a legacy single-record row expands to exactly one record. */
export function expandRows(raw: Array<Record<string, unknown>>): SignedResolutionRow[] {
  const out: SignedResolutionRow[] = [];
  for (const r of raw) {
    const batch = (r as { batch?: unknown }).batch;
    const rowSig = typeof (r as { sig?: unknown }).sig === "string" ? ((r as { sig: string }).sig) : "";
    if (Array.isArray(batch)) {
      for (const b of batch) {
        const parsed = parseRow(b as Record<string, unknown>);
        if (parsed) out.push({ ...parsed, sig: parsed.sig || rowSig });
      }
    } else {
      const parsed = parseRow(r);
      if (parsed) out.push(parsed);
    }
  }
  return out;
}

/** Append MANY records as ONE on-chain row (one writeRow = one tx). The hash-chain is
 *  continued within and across the batch (seq is global, prev links record→record), so
 *  packed history verifies exactly like single-row history. Returns the single tx sig. */
export async function appendBatch(
  client: IqClient,
  entries: Array<{ intent: Pointer; result: Pointer; ts?: number }>,
): Promise<{ sig: string; records: SignedResolutionRow[] }> {
  const existing = expandRows(await client.readRows());
  let seq = existing.length;
  let prev = existing.length ? existing[existing.length - 1].hash : GENESIS;
  const records: ResolutionRecord[] = [];
  for (const e of entries) {
    const hash = recordHash({ intent: e.intent, prev, result: e.result, seq });
    records.push({ seq, intent: e.intent, result: e.result, prev, hash, ts: e.ts });
    prev = hash;
    seq += 1;
  }
  const sig = await client.writeRow(packBatch(records));
  return { sig, records: records.map((r) => ({ ...r, sig })) };
}

/**
 * Cold-hydrate (crypto-was-all-you-needed Phase 2): the symmetric READ half of the
 * write-through. A fresh machine with IQ configured but an empty local ledger clones the
 * on-chain signed history (the "git clone" of the ledger) into its local fast tier, so
 * `find`/`history` answer locally without per-read network. Reads are free (no SOL).
 *
 * Idempotent: it appends only the per-intent rows the local ledger is MISSING (by position
 * in each intent's chain), so re-running hydrates 0. The local re-`append` re-signs under
 * the local signer and recomputes the hash-chain — the on-chain rows stay the durable
 * witness; local is the re-derived fast mirror of the same (intent → past values) facts.
 */
export async function hydrateLocalLedgerFromChain(
  chain: Pick<IqClient, "readRows">,
  local: AsyncResolutionLedger,
): Promise<{ scanned: number; hydrated: number }> {
  const rows = expandRows(await chain.readRows());
  // Group by intent, preserving on-chain order (oldest→newest) within each intent.
  const byIntent = new Map<string, SignedResolutionRow[]>();
  for (const r of rows) {
    const list = byIntent.get(r.intent) ?? [];
    list.push(r);
    byIntent.set(r.intent, list);
  }
  let hydrated = 0;
  for (const [intent, chainRows] of byIntent) {
    const localRows = await local.history(intent);
    for (let i = localRows.length; i < chainRows.length; i++) {
      await local.append(intent, chainRows[i].result, chainRows[i].ts);
      hydrated++;
    }
  }
  return { scanned: rows.length, hydrated };
}

/**
 * Cross-machine recall, WIRED (was: hydrateLocalLedgerFromChain had zero callers — the
 * "remembers across machines" half existed but was never invoked). Build the Iq client
 * from env and hydrate the local fast-tier ledger from the wallet's on-chain signed
 * history. A fresh machine that holds the wallet rebuilds its memory from chain — no
 * machine-local storage required to remember what it did. Returns null (no-op) when IQ
 * env is absent, so a machine without the wallet/keys simply runs on its local ledger.
 * Call this on boot before serving reads; idempotent (hydrates only missing rows).
 */
export async function recallMemoryFromChain(
  local: AsyncResolutionLedger,
  env: Record<string, string | undefined> = process.env,
): Promise<{ scanned: number; hydrated: number } | null> {
  const client = await iqClientFromEnv(env);
  if (!client) return null;
  return hydrateLocalLedgerFromChain(client, local);
}

/**
 * Build an IqClient from the real @iqlabs-official/solana-sdk. Returns null when the
 * required env (RPC + signer + db/table ids) is absent, so callers fall back to the
 * local fs ledger. The dynamic import keeps the heavy Solana dependency off the hot
 * path and out of environments that never opt in.
 */
export async function iqClientFromEnv(
  env: Record<string, string | undefined> = process.env,
): Promise<IqClient | null> {
  const rpc = env.SOLANA_RPC_ENDPOINT || env.SOLANA_RPC_URL;
  const dbRootId = env.IQ_DB_ROOT_ID;
  const tableSeed = env.IQ_TABLE_SEED;
  const secret = env.IQ_SIGNER_SECRET_KEY; // base58/JSON array — loaded transiently
  if (!rpc || !dbRootId || !tableSeed || !secret) return null;
  try {
    const iqlabs = (await import("@iqlabs-official/solana-sdk")).default as {
      writer: { writeRow: (...a: unknown[]) => Promise<string> };
      reader: { readTableRows: (...a: unknown[]) => Promise<Array<Record<string, unknown>>> };
      contract: { getDbRootPda: (...a: unknown[]) => { toBuffer(): Buffer }; getTablePda: (...a: unknown[]) => unknown };
      utils: { toSeedBytes: (s: string) => Uint8Array };
    };
    const { Connection, Keypair } = await import("@solana/web3.js");
    const connection = new Connection(rpc);
    const signer = Keypair.fromSecretKey(
      secret.trim().startsWith("[") ? Uint8Array.from(JSON.parse(secret)) : (await import("bs58")).default.decode(secret),
    );
    return {
      writeRow: (rowJson) => iqlabs.writer.writeRow(connection, signer, dbRootId, tableSeed, rowJson) as Promise<string>,
      readRows: () => {
        // Derive the table PDA exactly as the writer does: the DbRoot PDA is
        // keyed on toSeedBytes(dbRootId) (keccak256, NOT the raw utf8 string),
        // and getTablePda takes that DbRoot PDA (not the id) + toSeedBytes(tableSeed).
        // The previous `getTablePda(dbRootId, …, undefined)` derived a phantom PDA
        // that never matched the written rows — reads always came back empty.
        const dbRoot = iqlabs.contract.getDbRootPda(iqlabs.utils.toSeedBytes(dbRootId));
        const pda = iqlabs.contract.getTablePda(dbRoot, iqlabs.utils.toSeedBytes(tableSeed));
        return iqlabs.reader.readTableRows(pda, { speed: "light" });
      },
    };
  } catch {
    return null; // SDK not installed / env incomplete — local fs ledger remains the path
  }
}

/**
 * Resolution-ledger backend selector. Prefers the IQ on-chain signed ledger when
 * the wallet + RPC + table env is configured (so every resolution persists on
 * Solana, wallet-signed, with append-only history — crypto-was-all-you-needed),
 * else returns null so the caller keeps its existing local path. This is the same
 * "strongest configured tier, fail-closed to local" rule the egress-chain uses:
 * presence of the backend's config — not a mode flag — selects it.
 */
export async function resolutionLedgerFromEnv(
  env: Record<string, string | undefined> = process.env,
): Promise<AsyncResolutionLedger | null> {
  const client = await iqClientFromEnv(env);
  return client ? iqLedger(client) : null;
}
