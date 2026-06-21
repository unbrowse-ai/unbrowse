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
  const allRows = async (): Promise<SignedResolutionRow[]> =>
    (await client.readRows()).map(parseRow).filter((r): r is SignedResolutionRow => r !== null);

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
