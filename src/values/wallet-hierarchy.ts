/**
 * wallet-hierarchy — every layer of the descent stack has its OWN wallet that is
 * OWNED BY the layer above it: each layer's seed is HKDF-derived from its parent's
 * seed (so the parent can re-derive — and therefore controls — the child), and the
 * parent SIGNS the child's pubkey (the vertical route). This turns the single
 * signed descent (signed-descent.ts: one root signs every layer) into an ownership
 * tree — the root wallet owns the screen wallet owns the browser wallet … owns the
 * packet wallet, each routeed to the one above.
 *
 * Verification walks the vertical route chain from the root: every layer's parent
 * is the layer above, and the parent's signature over the child verifies. Swap any
 * layer's wallet, or the root, and it fails closed. (Derivation is deterministic, so
 * "ownership" is provable: the parent re-derives the exact child it routeed.)
 */
import { createPrivateKey, createPublicKey, hkdfSync, sign as nodeSign } from "node:crypto";
import { verifyEd25519 } from "./zk-binding.js";
import { withRootSeed } from "./signer.js";

const PKCS8_ED25519_PREFIX = Buffer.from("302e020100300506032b657004220420", "hex");
const bytesToHex = (b: Uint8Array): string => Buffer.from(b).toString("hex");

export interface KeyPair { pub: Uint8Array; sign: (msg: Uint8Array) => Uint8Array }

/** An Ed25519 keypair from a raw 32-byte seed (deterministic). Shared with
 *  layer-wallet-descent so each layer can sign with its own derived wallet. */
export function keypairFromSeed(seed: Uint8Array): KeyPair {
  const priv = createPrivateKey({ key: Buffer.concat([PKCS8_ED25519_PREFIX, Buffer.from(seed)]), format: "der", type: "pkcs8" });
  const spki = createPublicKey(priv).export({ format: "der", type: "spki" }) as Buffer;
  const pub = new Uint8Array(spki.subarray(spki.length - 32)); // raw pubkey = last 32 bytes of SPKI
  return { pub, sign: (msg) => new Uint8Array(nodeSign(null, Buffer.from(msg), priv)) };
}

/** Deterministic child seed from a parent seed + layer name (the parent owns it). */
export function childSeed(parentSeed: Uint8Array, layer: string): Uint8Array {
  return new Uint8Array(hkdfSync("sha256", parentSeed, Buffer.from("route-layer-v1"), Buffer.from(`child:${layer}`), 32));
}

export interface LayerWallet {
  layer: string;
  pubkey: string;       // this layer's wallet pubkey (hex)
  parent: string;       // the owning (parent) wallet pubkey (hex)
  routeSig: string;  // parent's Ed25519 signature over this child's pubkey (hex)
}

/**
 * Build the vertical ownership tree from the root seed down the layers. The root
 * wallet owns layer[0], which owns layer[1], … Each link: the parent derives the
 * child seed (ownership) and signs the child pubkey (route). Returns only
 * pubkeys + route signatures — no child seed ever leaves.
 */
export function buildLayerTree(rootSeed: Uint8Array, layers: readonly string[]): LayerWallet[] {
  const tree: LayerWallet[] = [];
  let ownerSeed = rootSeed;
  let owner = keypairFromSeed(rootSeed);
  let ownerPub = bytesToHex(owner.pub);
  for (const layer of layers) {
    const cs = childSeed(ownerSeed, layer);
    const child = keypairFromSeed(cs);
    const childPub = bytesToHex(child.pub);
    const routeSig = bytesToHex(owner.sign(Buffer.from(childPub, "utf8"))); // parent routes child
    tree.push({ layer, pubkey: childPub, parent: ownerPub, routeSig });
    ownerSeed = cs; owner = child; ownerPub = childPub;
  }
  return tree;
}

/** The root pubkey for a given root seed (the top of the ownership tree). */
export function rootPubkey(rootSeed: Uint8Array): string {
  return bytesToHex(keypairFromSeed(rootSeed).pub);
}

/** Build the layer tree owned by the REAL user wallet (seed loaded transiently,
 *  zeroed; only pubkeys + route signatures returned). */
export function walletLayerTree(layers: readonly string[]): { root: string; tree: LayerWallet[] } {
  return withRootSeed((seed) => ({ root: rootPubkey(seed), tree: buildLayerTree(seed, layers) }));
}

/** Walk the vertical route chain from `rootPub`: every layer's parent is the one
 *  above and the parent's route signature over the child verifies. Fails closed. */
export function verifyLayerTree(tree: LayerWallet[], rootPub: string): boolean {
  if (!tree.length) return false;
  let parent = rootPub;
  for (const w of tree) {
    if (w.parent !== parent) return false;
    try {
      if (!verifyEd25519(Buffer.from(w.parent, "hex"), Buffer.from(w.pubkey, "utf8"), Buffer.from(w.routeSig, "hex"))) {
        return false;
      }
    } catch {
      return false;
    }
    parent = w.pubkey;
  }
  return true;
}
