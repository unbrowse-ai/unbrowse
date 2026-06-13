/**
 * signed-descent — production port of the whitepaper's signed descent through every
 * layer of computer use (paper/reference/layers/descent.py, §3 of *Internal APIs
 * Were Not All You Needed*).
 *
 * Computer use is a self-similar stack: a screen click decomposes into a browser
 * action → an HTTP/CLI call → an OS syscall → a kernel operation → a packet on the
 * wire. The claim: every layer's action descends from ONE wallet signature — not a
 * fresh credential per layer, but one Ed25519/Solana root threaded down the stack,
 * each layer binding its own action to the same root via a hash chain.
 *
 * `descend(intent, ops)` signs a record at every layer, each chaining to the hash of
 * the layer above. `verifyDescent(chain, root)` is the seal: every layer signed by
 * the SAME root, correctly chained, untampered. Tamper any layer, or swap the
 * wallet, and verification fails closed.
 */
import { signBytes, getWalletPubkey } from "./signer.js";
import { verifyEd25519 } from "./zk-binding.js";

/** Top (closest to the human) → bottom (closest to the wire). */
export const LAYERS = ["screen", "browser", "cli", "os", "kernel", "packet"] as const;
import { GENESIS, sha256hex } from "./content-address.js"; // one source of truth (invariant #1/#6)

export interface DescentRecord {
  layer: string;
  op: string;
  intent: string;
  root: string;     // wallet pubkey hex — the one identity every layer descends from
  parent: string;   // hash of the layer above → the descent chain
  seq: number;
  sig: string;      // wallet Ed25519 signature over the canonical record (hex)
}

const bytesToHex = (b: Uint8Array): string => Buffer.from(b).toString("hex");

/** Canonical bytes of a record's signed core (deterministic, sorted keys). */
function canon(rec: Pick<DescentRecord, "layer" | "op" | "intent" | "root" | "parent" | "seq">): Uint8Array {
  const core = { intent: rec.intent, layer: rec.layer, op: rec.op, parent: rec.parent, root: rec.root, seq: rec.seq };
  return new TextEncoder().encode(JSON.stringify(core));
}

/** Produce a hash-chained, per-layer signed descent for `intent`. `ops[layer]` is
 *  the concrete operation at that layer (click coords, URL, argv, syscall, packet
 *  tuple). Every record is signed by the SAME wallet and chains to the one above. */
export async function descend(
  intent: string,
  ops: Record<string, string>,
  layers: readonly string[] = LAYERS,
): Promise<DescentRecord[]> {
  const root = bytesToHex(await getWalletPubkey()); // the one identity, known before signing
  const chain: DescentRecord[] = [];
  let parent = GENESIS;
  for (let seq = 0; seq < layers.length; seq++) {
    const layer = layers[seq];
    const core = { layer, op: ops[layer] ?? "", intent, root, parent, seq };
    const c = canon(core);
    const { sig } = await signBytes(c).then((r) => ({ sig: bytesToHex(r.signature) }));
    const rec: DescentRecord = { ...core, sig };
    chain.push(rec);
    parent = sha256hex(Buffer.concat([c, Buffer.from(sig, "utf8")]));
  }
  return chain;
}

/** The seal: every layer signed by the SAME root, chained, untampered. */
export function verifyDescent(chain: DescentRecord[], expectRoot: string): boolean {
  if (!chain.length) return false;
  let parent = GENESIS;
  const rootBytes = Buffer.from(expectRoot, "hex");
  for (let seq = 0; seq < chain.length; seq++) {
    const rec = chain[seq];
    if (rec.seq !== seq) return false;
    if (rec.root !== expectRoot) return false;       // every layer descends from one root
    if (rec.parent !== parent) return false;
    const c = canon(rec);
    if (!verifyEd25519(rootBytes, c, Buffer.from(rec.sig, "hex"))) return false;
    parent = sha256hex(Buffer.concat([c, Buffer.from(rec.sig, "utf8")]));
  }
  return true;
}
