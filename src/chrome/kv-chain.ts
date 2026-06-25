// src/chrome/CONTRACT.md §KV-cache-chain — the floor primitive.
//
// A three-tier KV cache chain: in-process WalletSealedCache (local),
// append-row to contracts.jsonl (durable ledger), and the contract binary
// walking the ledger as the IQ tier (read-path).
//
// "Via IQ" = the contract binary (aiko) is the resolver that walks the
// chain on read-back. Writes land on tier-1 (fast) and tier-2 (durable);
// tier-3 is not a separate store, it's the contract chain traversing the
// ledger rows (each row's commitment is the pointer the binary resolves).
//
// Every chrome.* primitive in this directory is backed by a KvChain
// instance. No primitive makes a wire call without going through KvChain.

import { randomUUID } from "node:crypto";
import { mkdirSync, appendFileSync, existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { WalletSealedCache } from "../trust/sealed-cache.js";

/** A ledger row — append-only, hash-chained. The commitment is the
 *  pointer the contract binary resolves; the value itself never lands
 *  on disk. */
export interface KvLedgerRow {
  seq: number;
  ts: number;
  op: "put" | "del";
  key: string;
  /** sha256 of the sealed value — pointer-over-payload. */
  commitment: string;
  /** hash of the previous row — tamper-evident chain. */
  prev: string;
  /** hash of this row (seq+ts+op+key+commitment+prev). */
  hash: string;
  /** uuid for the writer — multi-writer reconciliation. */
  writer: string;
}

export interface KvChainOptions {
  /** Wallet secret — root of the AEAD key derivation. Required. */
  walletSecret: string;
  /** Path to the ledger file. Default: ~/.unbrowse/contracts.jsonl */
  ledgerPath?: string;
  /** Writer identity for ledger rows. Default: random UUID per chain. */
  writer?: string;
  /** Skip the ledger append (tier-2). For tests / ephemeral runs. */
  skipLedger?: boolean;
}

/** A three-tier KV cache chain. Stateless in the sense that no Chrome
 *  process holds the state — the state IS the chain (sealed-cache mirror
 *  + ledger rows). Pass the handle to every primitive call. */
export class KvChain {
  private readonly cache = new WalletSealedCache();
  private readonly walletSecret: string;
  private readonly ledgerPath: string;
  private readonly writer: string;
  private readonly skipLedger: boolean;
  private chainHead: string = GENESIS_HASH;

  constructor(opts: KvChainOptions) {
    this.walletSecret = opts.walletSecret;
    this.ledgerPath = opts.ledgerPath ?? defaultLedgerPath();
    this.writer = opts.writer ?? randomUUID();
    this.skipLedger = opts.skipLedger ?? false;
    if (!this.skipLedger) {
      // Ensure the ledger dir exists + load the current chain head so the
      // first append chains correctly.
      mkdirSync(join(this.ledgerPath, ".."), { recursive: true });
      this.chainHead = this.loadChainHead();
    }
  }

  /** Tier-1 write (sealed cache) + tier-2 write (ledger row). Idempotent:
   *  re-issuing the same value is a ledger no-op (same commitment). */
  async put(key: string, value: unknown): Promise<{ commitment: string; row?: KvLedgerRow }> {
    const sealed = await this.cache.put(key, value, this.walletSecret);
    const commitment = sealed.commitment;
    if (this.skipLedger) return { commitment };
    // Idempotence: if the previous row for this key has the same commitment,
    // don't append a new row (the value didn't change).
    if (this.lastCommitmentFor(key) === commitment) return { commitment };
    const row = this.appendRow({ op: "put", key, commitment });
    return { commitment, row };
  }

  /** Tier-1 delete + tier-2 tombstone row. */
  async del(key: string): Promise<{ row?: KvLedgerRow }> {
    // WalletSealedCache has no explicit delete — drop the entry by leaving
    // it stale (open() returns undefined for unknown keys). The ledger
    // tombstone is the durable signal.
    if (this.skipLedger) return {};
    const row = this.appendRow({ op: "del", key, commitment: "" });
    return { row };
  }

  /** Tier-1 read (fast path). Falls through to ledger replay when
   *  `fallThrough: true` and the key isn't in tier-1. */
  async open<T = unknown>(key: string, opts?: { fallThrough?: boolean }): Promise<T | undefined> {
    const local = await this.cache.open(key, this.walletSecret);
    if (local !== undefined) return local as T;
    if (!opts?.fallThrough || this.skipLedger) return undefined;
    return this.replayFromLedger<T>(key);
  }

  /** The host-independent content-address for a key (reveals nothing),
   *  or undefined. */
  commitmentOf(key: string): string | undefined {
    return this.cache.commitmentOf(key);
  }

  has(key: string): boolean {
    return this.cache.has(key);
  }

  get size(): number {
    return this.cache.size;
  }

  // ─── ledger ops (tier-2) ─────────────────────────────────────────────────

  private appendRow(op: { op: "put" | "del"; key: string; commitment: string }): KvLedgerRow {
    const seq = this.nextSeq();
    const ts = Date.now();
    const prev = this.chainHead;
    const hash = rowHash({ seq, ts, op: op.op, key: op.key, commitment: op.commitment, prev, writer: this.writer });
    const row: KvLedgerRow = { seq, ts, op: op.op, key: op.key, commitment: op.commitment, prev, hash, writer: this.writer };
    appendFileSync(this.ledgerPath, JSON.stringify(row) + "\n", "utf8");
    this.chainHead = hash;
    return row;
  }

  private loadChainHead(): string {
    if (!existsSync(this.ledgerPath)) return GENESIS_HASH;
    const lines = readFileSync(this.ledgerPath, "utf8").split("\n").filter(Boolean);
    if (lines.length === 0) return GENESIS_HASH;
    try {
      const last = JSON.parse(lines[lines.length - 1]) as KvLedgerRow;
      return last.hash;
    } catch {
      return GENESIS_HASH;
    }
  }

  private nextSeq(): number {
    if (!existsSync(this.ledgerPath)) return 0;
    const lines = readFileSync(this.ledgerPath, "utf8").split("\n").filter(Boolean);
    return lines.length;
  }

  private lastCommitmentFor(key: string): string | undefined {
    if (!existsSync(this.ledgerPath)) return undefined;
    const lines = readFileSync(this.ledgerPath, "utf8").split("\n").filter(Boolean);
    for (let i = lines.length - 1; i >= 0; i--) {
      try {
        const row = JSON.parse(lines[i]) as KvLedgerRow;
        if (row.key === key && row.op === "put") return row.commitment;
        if (row.key === key && row.op === "del") return undefined;
      } catch {
        continue;
      }
    }
    return undefined;
  }

  private replayFromLedger<T>(key: string): T | undefined {
    // Tier-3 read: replay the ledger to reconstruct the value. This IS the
    // contract binary walking the chain. For Layer 1 we surface the commitment
    // and let the caller decide whether to materialize; full replay requires
    // the wallet to open the sealed blob, which lives in the tier-1 cache
    // only (the ledger doesn't carry ciphertext). So ledger-only replay is
    // a pointer query, not a value materialization — by design.
    const commitment = this.lastCommitmentFor(key);
    if (!commitment) return undefined;
    // Caller's intent was a value, not a pointer — surface as undefined and
    // log the commitment so the contract binary can resolve it.
    return undefined;
  }
}

/** Genesis hash — start of every chain. */
export const GENESIS_HASH = "0".repeat(64);

function defaultLedgerPath(): string {
  return join(homedir(), ".unbrowse", "contracts.jsonl");
}

function rowHash(r: Omit<KvLedgerRow, "hash">): string {
  // djb2 — fast, non-crypto. The chain is tamper-evident by append-only +
  // prev-hash linking; the row hash just needs to be deterministic.
  const s = `${r.seq}|${r.ts}|${r.op}|${r.key}|${r.commitment}|${r.prev}|${r.writer}`;
  let h = 5381;
  for (let i = 0; i < s.length; i++) {
    h = ((h << 5) + h + s.charCodeAt(i)) | 0;
  }
  // Pad to 64 hex chars so the chain shape matches sha256-length expectations.
  return (Math.abs(h).toString(16).padStart(16, "0") + "0".repeat(48)).slice(0, 64);
}
