/**
 * sealed-ledger — production port of the whitepaper's commitment half
 * (paper/reference/ledger/ledger.py, §7 of *Internal APIs Were Not All You
 * Needed*), combined with the wallet seal (§5).
 *
 * "Value off-chain, root on-chain." Each appended value is SEALED under the wallet
 * key (wallet-seal: only the holder can reveal it) and the ledger carries only its
 * content hash in a signed, append-only, hash-chained row {seq, signer, valueHash,
 * ts, prev, sig}. `prev` is the hash of the prior row's canonical bytes + its
 * signature, so reordering or editing any past row breaks every row after it
 * (Bitcoin hash chain). `root()` is the single RFC-6962 Merkle commitment over the
 * whole log — the value an on-chain checkpoint would publish. The value itself
 * never appears in the log, and only the wallet holder can `reveal` it.
 *
 * This is the last autonomously-shippable node of the ZK stack: any key/value is
 * sealed to the user's wallet AND auditably committed, ordered, and signed.
 */
import { createHash } from "node:crypto";
import { signBytes, getWalletPubkey, deriveSealKey } from "./signer.js";
import { verifyEd25519 } from "./zk-binding.js";
import { sealValue, revealValue } from "./wallet-seal.js";

import { GENESIS, sha256hex } from "./content-address.js"; // one source of truth (commandments #1/#6)
const bytesToHex = (b: Uint8Array): string => Buffer.from(b).toString("hex");

export interface LedgerEntry {
  seq: number;
  signer: string;     // wallet pubkey hex
  valueHash: string;  // sha256 of the PLAINTEXT (the sealed value lives off-log)
  ts: number;
  prev: string;       // hash of the prior row → the chain
  sig: string;        // wallet Ed25519 signature over the canonical core (hex)
}

/** Canonical bytes of a row EXCLUDING its own signature (the sig signs this). */
function canon(e: Omit<LedgerEntry, "sig">): Uint8Array {
  const core = { prev: e.prev, seq: e.seq, signer: e.signer, ts: e.ts, valueHash: e.valueHash };
  return new TextEncoder().encode(JSON.stringify(core));
}

/** RFC-6962 Merkle Tree Hash over the row hashes. Empty → sha256(""). Exported as the
 *  one source of truth for the shared-graph merge commitment (graph-merge). */
export function merkleRoot(leafHexes: string[]): string {
  if (!leafHexes.length) return sha256hex(new Uint8Array());
  let level = leafHexes.map((h) => Buffer.from(h, "hex"));
  while (level.length > 1) {
    const next: Buffer[] = [];
    for (let i = 0; i < level.length; i += 2) {
      if (i + 1 < level.length) {
        next.push(createHash("sha256").update(Buffer.concat([Buffer.from([0x01]), level[i], level[i + 1]])).digest());
      } else {
        next.push(level[i]); // odd leaf promoted
      }
    }
    level = next;
  }
  return level[0].toString("hex");
}

export class SealedLedger {
  private entries: LedgerEntry[] = [];
  private sealedStore = new Map<string, Uint8Array>(); // valueHash → sealed blob (off-log)
  private sealKey: Uint8Array;
  private signer = "";

  constructor() {
    this.sealKey = deriveSealKey();
  }

  /** Seal `value` to the wallet and append a signed, chained commitment to its hash. */
  async append(value: Uint8Array, ts: number): Promise<LedgerEntry> {
    if (!this.signer) this.signer = bytesToHex(await getWalletPubkey());
    const { hash, sealed } = sealValue(value, this.sealKey);
    this.sealedStore.set(hash, sealed);
    const last = this.entries[this.entries.length - 1];
    const prev = last ? sha256hex(Buffer.concat([canon(last), Buffer.from(last.sig, "utf8")])) : GENESIS;
    const core = { seq: this.entries.length, signer: this.signer, valueHash: hash, ts, prev };
    const { signature } = await signBytes(canon(core));
    const entry: LedgerEntry = { ...core, sig: bytesToHex(signature) };
    this.entries.push(entry);
    return entry;
  }

  /** Reveal a sealed value — ONLY the wallet holder's key opens it. */
  reveal(valueHash: string): Uint8Array {
    const sealed = this.sealedStore.get(valueHash);
    if (!sealed) throw new Error(`no sealed value for ${valueHash.slice(0, 8)}`);
    return revealValue(valueHash, sealed, this.sealKey);
  }

  /** The seal: every prev links and every signature verifies against its signer. */
  verifyChain(): boolean {
    let prev = GENESIS;
    for (let i = 0; i < this.entries.length; i++) {
      const e = this.entries[i];
      if (e.seq !== i) return false;
      if (e.prev !== prev) return false;
      if (!verifyEd25519(Buffer.from(e.signer, "hex"), canon(e), Buffer.from(e.sig, "hex"))) return false;
      prev = sha256hex(Buffer.concat([canon(e), Buffer.from(e.sig, "utf8")]));
    }
    return true;
  }

  /** The single on-chain-checkpointable commitment over the whole log. */
  root(): string {
    return merkleRoot(this.entries.map((e) => sha256hex(Buffer.concat([canon(e), Buffer.from(e.sig, "utf8")]))));
  }

  rows(): readonly LedgerEntry[] { return this.entries; }
}
