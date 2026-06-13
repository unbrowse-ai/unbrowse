/**
 * layer-wallet-descent — wallet-hierarchy ∘ signed-descent. The plain signed descent
 * (signed-descent.ts) has ONE root sign every layer. Here each layer signs its OWN
 * action with its OWN wallet — the wallet that the layer above OWNS (HKDF-derived)
 * and ROUTEED (signed). So a packet-layer action is signed by the packet wallet,
 * which is owned by the kernel wallet, … owned by the user's root: authority descends
 * vertically, each layer accountable with a distinct key it cannot escape.
 *
 * Each record carries TWO signatures:
 *   routeSig — the PARENT's signature over this layer's pubkey (vertical ownership)
 *   actionSig   — THIS layer's wallet signing its own action (intent/op/chain)
 * plus prevHash, the horizontal descent chain. verifyLayerWalletDescent checks all
 * three from the root; tamper an action, swap a layer wallet, or change the root and
 * it fails closed.
 */
import { withRootSeed } from "./signer.js";
import { verifyEd25519 } from "./zk-binding.js";
import { keypairFromSeed, childSeed } from "./wallet-hierarchy.js";
import { LAYERS } from "./signed-descent.js";

import { GENESIS, sha256hex } from "./content-address.js"; // one source of truth (invariant #1/#6)
const bytesToHex = (b: Uint8Array): string => Buffer.from(b).toString("hex");

export interface LayerSignedRecord {
  layer: string;
  op: string;
  intent: string;
  seq: number;
  pubkey: string;      // this layer's own wallet
  parent: string;      // the owning (parent) layer's wallet
  routeSig: string; // parent's signature over this layer's pubkey (vertical ownership)
  prevHash: string;    // hash of the record above (horizontal descent chain)
  actionSig: string;   // THIS layer's wallet signs its own action core
}

/** Canonical bytes of the action core a layer signs (excludes the two signatures). */
function actionCore(r: Pick<LayerSignedRecord, "layer" | "op" | "intent" | "seq" | "pubkey" | "parent" | "prevHash">): Uint8Array {
  const core = { intent: r.intent, layer: r.layer, op: r.op, parent: r.parent, prevHash: r.prevHash, pubkey: r.pubkey, seq: r.seq };
  return new TextEncoder().encode(JSON.stringify(core));
}

/** Build a descent where each layer signs with its own parent-owned wallet. */
export function descendByLayerWallet(
  intent: string,
  ops: Record<string, string>,
  layers: readonly string[] = LAYERS,
): { root: string; chain: LayerSignedRecord[] } {
  return withRootSeed((seed) => {
    const root = keypairFromSeed(seed);
    const rootPub = bytesToHex(root.pub);
    const chain: LayerSignedRecord[] = [];
    let ownerSeed = seed;
    let owner = root;
    let ownerPub = rootPub;
    let prevHash = GENESIS;
    for (let seq = 0; seq < layers.length; seq++) {
      const layer = layers[seq];
      const cs = childSeed(ownerSeed, layer);
      const child = keypairFromSeed(cs);
      const childPub = bytesToHex(child.pub);
      const routeSig = bytesToHex(owner.sign(Buffer.from(childPub, "utf8"))); // parent routes child
      const core = { layer, op: ops[layer] ?? "", intent, pubkey: childPub, parent: ownerPub, prevHash, seq };
      const c = actionCore(core);
      const actionSig = bytesToHex(child.sign(c)); // this layer's own wallet signs its action
      chain.push({ ...core, routeSig, actionSig });
      prevHash = sha256hex(Buffer.concat([c, Buffer.from(actionSig, "utf8")]));
      ownerSeed = cs; owner = child; ownerPub = childPub;
    }
    return { root: rootPub, chain };
  });
}

/** Verify all three bindings from the root: vertical ownership route, each
 *  layer's own action signature, and the horizontal descent chain. */
export function verifyLayerWalletDescent(chain: LayerSignedRecord[], rootPub: string): boolean {
  if (!chain.length) return false;
  let parent = rootPub;
  let prevHash = GENESIS;
  for (let seq = 0; seq < chain.length; seq++) {
    const r = chain[seq];
    if (r.seq !== seq || r.parent !== parent || r.prevHash !== prevHash) return false;
    try {
      // vertical: the parent owns (routeed) this layer's wallet
      if (!verifyEd25519(Buffer.from(r.parent, "hex"), Buffer.from(r.pubkey, "utf8"), Buffer.from(r.routeSig, "hex"))) return false;
      // self: this layer signed its OWN action with its OWN wallet
      const c = actionCore(r);
      if (!verifyEd25519(Buffer.from(r.pubkey, "hex"), c, Buffer.from(r.actionSig, "hex"))) return false;
      prevHash = sha256hex(Buffer.concat([c, Buffer.from(r.actionSig, "utf8")]));
    } catch {
      return false;
    }
    parent = r.pubkey;
  }
  return true;
}
