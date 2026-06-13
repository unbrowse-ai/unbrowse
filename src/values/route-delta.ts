/**
 * route-delta — the contributed UNIT of the shared route graph (plan node 1,
 * internal/zk-delta-contribution-plan.md §"phased build plan").
 *
 * A contribution is not "publish a route"; it is an APPEND of a content-addressed,
 * wallet-signed, hash-chained DELTA. The shape (method / URL-shape / param-keys /
 * schema — the secret-stripped structure of a captured route) is carried only as a
 * content POINTER (its sha256), never as raw bytes, so the delta reveals nothing about
 * the capture beyond a hash. Each delta descends from ONE wallet root (signed-descent,
 * §3) and chains to the prior delta's id (sealed-ledger, §7), so reordering or editing
 * any admitted delta breaks every id after it. This is the cross-agent ledger row that
 * node 4's CRDT merge admits behind the node-2 validity + node-3 attestation proofs.
 *
 * Reuses the substrate verbatim: content-address (sha256/contentPointer), signer
 * (Ed25519 signBytes/getWalletPubkey), and zk-binding's verifyEd25519 — the same
 * primitives signed-descent and sealed-ledger already stand on.
 */
import { signBytes, getWalletPubkey } from "./signer.js";
import { verifyEd25519 } from "./zk-binding.js";
import { GENESIS, sha256hex, contentPointer, type Pointer } from "./content-address.js";

/** The CRDT operation a delta carries against the shared graph. */
export type DeltaOp = "add" | "update" | "supersede";

/** A signed, content-addressed contribution to the shared route graph. */
export interface RouteDelta {
  /** What this delta does to the route at `endpoint`. */
  op: DeltaOp;
  /** Canonical endpoint id the delta acts on (e.g. "GET api.example.com/v1/items"). */
  endpoint: string;
  /** Content pointer (sha256) of the secret-stripped route STRUCTURE — never the bytes. */
  shape: Pointer;
  /** Freshness claim: ms-epoch the capture proving this route was observed. */
  freshness: number;
  /** Contributor wallet pubkey hex — the one root every layer of the contribution descends from. */
  walletRoot: string;
  /** Id of the prior delta in this contributor's chain (GENESIS for the first). */
  prev: string;
  /** Ordinal within the contributor's chain. */
  seq: number;
  /** Wallet Ed25519 signature (hex) over the canonical core. */
  sig: string;
}

/** The signed core of a delta (everything but the signature). */
type DeltaCore = Omit<RouteDelta, "sig">;

/** Deterministic canonical bytes of a delta's signed core (sorted keys → stable hash). */
function canon(c: DeltaCore): Uint8Array {
  const core = {
    endpoint: c.endpoint,
    freshness: c.freshness,
    op: c.op,
    prev: c.prev,
    seq: c.seq,
    shape: c.shape,
    walletRoot: c.walletRoot,
  };
  return new TextEncoder().encode(JSON.stringify(core));
}

const bytesToHex = (b: Uint8Array): string => Buffer.from(b).toString("hex");

/** Content pointer of a route structure — the value of a delta's `shape` field. The
 *  structure must already be secret-stripped (obfuscateCaptureForReveng); this only
 *  hashes it, so the raw structure never travels inside the delta. */
export function shapePointer(structure: unknown): Pointer {
  return contentPointer(JSON.stringify(structure));
}

/** The content-address (id) of a delta: the hash of its canonical core + signature.
 *  Deterministic and tamper-evident — the next delta's `prev` is exactly this. */
export function deltaId(d: RouteDelta): string {
  return sha256hex(Buffer.concat([canon(d), Buffer.from(d.sig, "utf8")]));
}

/** Build and wallet-sign a RouteDelta. `prev` defaults to GENESIS (chain head). */
export async function signDelta(params: {
  op: DeltaOp;
  endpoint: string;
  shape: Pointer;
  freshness: number;
  prev?: string;
  seq?: number;
}): Promise<RouteDelta> {
  const walletRoot = bytesToHex(await getWalletPubkey());
  const core: DeltaCore = {
    op: params.op,
    endpoint: params.endpoint,
    shape: params.shape,
    freshness: params.freshness,
    walletRoot,
    prev: params.prev ?? GENESIS,
    seq: params.seq ?? 0,
  };
  const { signature } = await signBytes(canon(core));
  return { ...core, sig: bytesToHex(signature) };
}

/** Verify a single delta: the wallet signed exactly this core, and it descends from
 *  `expectRoot`. Any tampered field (op/endpoint/shape/freshness/prev/seq) or a forged
 *  root/signature fails closed. */
export function verifyDelta(d: RouteDelta, expectRoot: string): boolean {
  if (d.walletRoot !== expectRoot) return false;
  const rootBytes = Buffer.from(expectRoot, "hex");
  return verifyEd25519(rootBytes, canon(d), Buffer.from(d.sig, "hex"));
}

/** Verify a contributor's chain: every delta signed by the SAME root, correctly
 *  ordered, each `prev` equal to the prior delta's id (GENESIS for the first). Tamper
 *  any delta, reorder, or swap the wallet ⇒ false (the sealed-ledger property, applied
 *  to the contribution chain). */
export function verifyDeltaChain(deltas: RouteDelta[], expectRoot: string): boolean {
  if (!deltas.length) return false;
  let prev = GENESIS;
  for (let seq = 0; seq < deltas.length; seq++) {
    const d = deltas[seq];
    if (d.seq !== seq) return false;
    if (d.prev !== prev) return false;
    if (!verifyDelta(d, expectRoot)) return false;
    prev = deltaId(d);
  }
  return true;
}
