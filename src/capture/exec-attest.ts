/**
 * exec-attest — the execution attestation (plan node 3,
 * internal/zk-delta-contribution-plan.md).
 *
 * A contributor must not be able to earn settlement for a route it never actually hit.
 * The attestation binds, under the contributor's wallet root, the ORIGIN the skill
 * executed against and the SHAPE of the response it observed — so a fabricated delta
 * (claiming an origin/shape the contributor never produced) fails closed, and an
 * attestation cannot be replayed onto a different delta (origin + shape + nonce binding).
 *
 * Honesty boundary (mirrors the zk-gate scope note): a wallet self-signature proves the
 * contributor COMMITS to "I executed against O and saw shape S", non-replayably and
 * non-swappably — it does not yet prove the TLS session happened to a third party. The
 * deployment upgrade is an MPC-TLS / TLSNotary web-proof: swap the `proof` carrier from a
 * wallet signature to a notary attestation; the verify interface and the delta-binding
 * below are unchanged. The shape pointer equals the delta's `shape`, so attestation and
 * delta are cryptographically the same route.
 */
import { signBytes, getWalletPubkey } from "../values/signer.js";
import { verifyEd25519 } from "../values/zk-binding.js";
import type { Pointer } from "../values/content-address.js";
import type { RouteDelta } from "../values/route-delta.js";
import { randomBytes, generateKeyPairSync, sign as nodeSign } from "node:crypto";

/** A third-party notary's proof over the same attested fields — the carrier that upgrades
 *  a wallet SELF-attestation to a witnessed one. Today: a reference notary keypair. In
 *  production: an MPC-TLS / TLSNotary web-proof (via UNBROWSE_NOTARY_URL) carried in the
 *  same shape; `verifyNotary` is the unchanged interface. */
export interface NotaryProof {
  /** The notary's 32-byte Ed25519 pubkey (hex); must be in the verifier's trusted set. */
  notaryPubkey: string;
  /** The notary's signature (hex) over the SAME canonical attestation the wallet signs. */
  sig: string;
}

/** A wallet-bound attestation that a skill executed against `origin` and observed `shapeHash`. */
export interface ExecAttestation {
  /** Scheme + host the skill executed against, e.g. "https://api.example.com". */
  origin: string;
  /** HTTP method exercised. */
  method: string;
  /** Content pointer of the observed response shape — equals the delta's `shape`. */
  shapeHash: Pointer;
  /** ms-epoch the execution was observed. */
  capturedAt: number;
  /** Random nonce — makes each attestation unique (anti-replay). */
  nonce: string;
  /** Contributor wallet pubkey hex — the one root the delta also descends from. */
  walletRoot: string;
  /** Wallet Ed25519 signature (hex) over the canonical attestation (the self-attested floor). */
  sig: string;
  /** Optional third-party notary proof over the same fields (the witnessed upgrade). */
  notary?: NotaryProof;
}

type AttestCore = Omit<ExecAttestation, "sig">;

function canon(c: AttestCore): Uint8Array {
  const core = {
    capturedAt: c.capturedAt,
    method: c.method,
    nonce: c.nonce,
    origin: c.origin,
    shapeHash: c.shapeHash,
    walletRoot: c.walletRoot,
  };
  return new TextEncoder().encode(JSON.stringify(core));
}

const bytesToHex = (b: Uint8Array): string => Buffer.from(b).toString("hex");

/** host of an origin URL ("https://api.example.com/x" → "api.example.com"); "" if unparsable. */
function originHost(origin: string): string {
  try { return new URL(origin).host; } catch { return ""; }
}

/** host of a delta endpoint ("GET api.example.com/v1/items" → "api.example.com"). */
function endpointHost(endpoint: string): string {
  const target = endpoint.split(" ").pop() ?? "";
  return target.split("/")[0] ?? "";
}

/** Build and wallet-sign an execution attestation. */
export async function attestExecution(params: {
  origin: string;
  method: string;
  shapeHash: Pointer;
  capturedAt?: number;
  nonce?: string;
}): Promise<ExecAttestation> {
  const walletRoot = bytesToHex(await getWalletPubkey());
  const core: AttestCore = {
    origin: params.origin,
    method: params.method,
    shapeHash: params.shapeHash,
    capturedAt: params.capturedAt ?? Date.now(),
    nonce: params.nonce ?? randomBytes(16).toString("hex"),
    walletRoot,
  };
  const { signature } = await signBytes(canon(core));
  return { ...core, sig: bytesToHex(signature) };
}

/** Verify the attestation is signed by `expectRoot` over exactly this content. An
 *  origin-swap, shape-swap, or any tamper fails closed. */
export function verifyAttestation(att: ExecAttestation, expectRoot: string): boolean {
  if (att.walletRoot !== expectRoot) return false;
  return verifyEd25519(Buffer.from(expectRoot, "hex"), canon(att), Buffer.from(att.sig, "hex"));
}

/** The attestation↔delta binding the merge gate checks: same wallet root, same response
 *  shape, and the attested origin's host matches the delta's endpoint host. An attestation
 *  for one route cannot be replayed to admit a different one. */
export function attestationBindsDelta(att: ExecAttestation, delta: RouteDelta): boolean {
  if (att.walletRoot !== delta.walletRoot) return false;
  if (att.shapeHash !== delta.shape) return false;
  const oh = originHost(att.origin);
  return oh !== "" && oh === endpointHost(delta.endpoint);
}

/** A notary that signs the same attested fields, attaching a NotaryProof carrier. */
export interface Notary {
  /** The notary's 32-byte Ed25519 pubkey (hex) — register in the verifier's trusted set. */
  pubkey: string;
  /** Attach this notary's proof to an attestation (over the SAME canonical fields). */
  notarize(att: ExecAttestation): ExecAttestation;
}

/**
 * A REFERENCE notary: a local Ed25519 keypair modeling the MPC-TLS / TLSNotary output — it
 * signs the same fields the wallet does, asserting a third party witnessed the session.
 * Production swaps this for the real notary service (UNBROWSE_NOTARY_URL); the NotaryProof
 * carrier and `verifyNotary` interface are unchanged. The private key never leaves here.
 */
export function referenceNotary(): Notary {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  // raw 32-byte Ed25519 pubkey = the tail of the SPKI DER (matches verifyEd25519's prefix trick).
  const rawPub = publicKey.export({ format: "der", type: "spki" }).subarray(-32);
  const pubkey = Buffer.from(rawPub).toString("hex");
  return {
    pubkey,
    notarize(att: ExecAttestation): ExecAttestation {
      const sig = nodeSign(null, Buffer.from(canon(att)), privateKey);
      return { ...att, notary: { notaryPubkey: pubkey, sig: Buffer.from(sig).toString("hex") } };
    },
  };
}

/** Verify the notary carrier: a TRUSTED notary signed exactly this attestation's fields.
 *  Returns false if there is no notary proof, the notary is untrusted, or the signature does
 *  not match the canonical attestation (origin-swap / tamper fails closed). The wallet
 *  self-signature is verified separately by `verifyAttestation` — the two are independent. */
export function verifyNotary(att: ExecAttestation, trusted: Set<string>): boolean {
  if (!att.notary) return false;
  if (!trusted.has(att.notary.notaryPubkey)) return false;
  return verifyEd25519(
    Buffer.from(att.notary.notaryPubkey, "hex"),
    canon(att),
    Buffer.from(att.notary.sig, "hex"),
  );
}
