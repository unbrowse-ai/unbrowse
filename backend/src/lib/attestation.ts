/**
 * Server-spawn attestation gate — verifies that a `/v1/contract/declare`
 * caller's lineage chain terminates at Lewis's deployer-identity pubkey.
 *
 * Implements `~/.contract-refactor-design/03-attestation-gate.md` § 3
 * (protocol flow) and § 4 (bootstrap = hardcoded-at-compile-time). The
 * primitive is "verify lineage walk + body signature against pinned root":
 *
 *   1. Caller sends two headers along with the JSON body:
 *        x-aiko-lineage-chain   = base64url(JSON of LineageLink[])
 *        x-aiko-spawn-signature = hex(ed25519(leaf_kp, nonce ‖ body))
 *        x-aiko-spawn-nonce     = hex(nonce) [first-shot allowed: empty]
 *   2. Each LineageLink carries (contract_id, env_pubkey, parent_id,
 *      parent_signature). The walk verifies link[i+1].env_pubkey signed
 *      link[i].env_pubkey (chain integrity).
 *   3. The chain's terminus (root) MUST equal LEWIS_DEPLOYER_PUBKEY_v1.
 *   4. The leaf's `env_pubkey` MUST verify the signature header over
 *      (nonce ‖ canonical-body-bytes).
 *
 * NO new crypto is invented — every primitive reuses Web Crypto's
 * ed25519 implementation already wired through `declare-signature.ts`.
 *
 * Phase-1 (this commit): the header gate is OPTIONAL. Requests without
 * `x-aiko-spawn-signature` succeed under the "legacy-anonymous"
 * admission, surfaced as an evidence string in the declare response so
 * observers can track migration. Per design doc § 7 the legacy window
 * is 30 days; after that the absence of attestation rejects.
 *
 * Phase-2 (follow-up): LEWIS_DEPLOYER_PUBKEY_v1 gets the real hex
 * baked in from `~/.aiko/keys/deployer.pub`. Until Lewis pastes the
 * value, this file ships with the sentinel below so the verification
 * path is testable end-to-end without exposing the real pubkey in CI.
 */

/**
 * TODO(wave-2c): set LEWIS_DEPLOYER_PUBKEY_v1 from
 *   `cat ~/.aiko/keys/deployer.pub | xxd -r -p | xxd -p -c 32`
 * before merging the cutover PR. Until Lewis pastes the hex, the
 * sentinel below is unreachable by any real spawn — every signature
 * verification against it WILL fail, which keeps the gate honest:
 * attested-mode is opt-in, legacy mode is the default, and the
 * day-30 cutover is what Lewis triggers by replacing the sentinel
 * with the real pubkey + flipping ATTESTATION_REQUIRED on.
 */
export const LEWIS_DEPLOYER_PUBKEY_v1 =
  "0000000000000000000000000000000000000000000000000000000000000000";

/** The window after which legacy-anonymous declares stop being admitted. */
export const LEGACY_WINDOW_ENDS = "2026-06-25T00:00:00.000Z";

export interface LineageLink {
  contract_id: string;
  /** Hex-encoded ed25519 pubkey for this link. */
  env_pubkey: string;
  /** Predecessor's contract id, or null for the root. */
  parent_id: string | null;
  /** Hex-encoded ed25519 signature: this link's env_pubkey signed by parent. */
  parent_signature: string;
}

export interface VerifySpawnAttestationInput {
  /** Raw value of x-aiko-lineage-chain header (base64url or raw JSON). */
  lineageChainHeader: string;
  /** Raw value of x-aiko-spawn-signature header (hex). */
  signatureHeader: string;
  /** Raw value of x-aiko-spawn-nonce header (hex). Empty allowed for first-shot. */
  nonceHeader: string | null;
  /** Canonical request body bytes (signed by the leaf). */
  bodyBytes: Uint8Array;
  /** Expected root pubkey (hex). Defaults to LEWIS_DEPLOYER_PUBKEY_v1. */
  expectedRootPubkey?: string;
}

export type VerifySpawnAttestationResult =
  | { ok: true; leafPubkey: string; rootPubkey: string }
  | { ok: false; reason: string };

function hexToBytes(hex: string): Uint8Array {
  const clean = hex.startsWith("0x") ? hex.slice(2) : hex;
  if (clean.length % 2 !== 0) {
    throw new Error("hex string must have even length");
  }
  const out = new Uint8Array(clean.length / 2);
  for (let i = 0; i < out.length; i++) {
    out[i] = parseInt(clean.substring(i * 2, i * 2 + 2), 16);
  }
  return out;
}

function decodeLineageChain(header: string): LineageLink[] {
  // Accept either raw JSON or base64url-wrapped JSON (header values
  // need to be ASCII-safe). Probe JSON first; fall back to base64url.
  let text = header.trim();
  if (text.startsWith("[")) {
    // already JSON
  } else {
    // base64url decode
    const padded = text.replace(/-/g, "+").replace(/_/g, "/");
    const pad = padded.length % 4 === 0 ? "" : "=".repeat(4 - (padded.length % 4));
    try {
      text = atob(padded + pad);
    } catch (e) {
      throw new Error(`lineage_chain header is neither JSON nor base64url: ${(e as Error).message}`);
    }
  }
  const parsed = JSON.parse(text);
  if (!Array.isArray(parsed)) throw new Error("lineage_chain must be a JSON array");
  return parsed as LineageLink[];
}

async function verifyEd25519(
  pubkeyHex: string,
  signatureHex: string,
  dataBytes: Uint8Array,
): Promise<boolean> {
  try {
    const pub = hexToBytes(pubkeyHex);
    if (pub.length !== 32) return false;
    const sig = hexToBytes(signatureHex);
    if (sig.length !== 64) return false;
    const key = await crypto.subtle.importKey(
      "raw",
      pub,
      { name: "Ed25519" },
      false,
      ["verify"],
    );
    return await crypto.subtle.verify({ name: "Ed25519" }, key, sig, dataBytes);
  } catch {
    return false;
  }
}

/**
 * Verify a server-spawn attestation. The check terminates honest:
 *   - chain malformed             → ok=false, reason starts with "lineage_chain_*"
 *   - chain link fails verify     → ok=false, reason "lineage_link_<i>_invalid"
 *   - terminus pubkey ≠ expected  → ok=false, reason "root_mismatch"
 *   - leaf signature fails verify → ok=false, reason "signature_invalid"
 *   - everything passes           → ok=true, leafPubkey + rootPubkey returned
 *
 * Pure: no I/O, no clock. Safe to call from the request hot path before
 * any other gate (rate limiter, ledger write, LLM compile).
 */
export async function verifySpawnAttestation(
  input: VerifySpawnAttestationInput,
): Promise<VerifySpawnAttestationResult> {
  let chain: LineageLink[];
  try {
    chain = decodeLineageChain(input.lineageChainHeader);
  } catch (e) {
    return { ok: false, reason: `lineage_chain_decode_error: ${(e as Error).message}` };
  }
  if (chain.length === 0) {
    return { ok: false, reason: "lineage_chain_empty" };
  }

  // Convention: chain[0] = leaf (current caller), chain[last] = root.
  // Each non-root link's parent_signature signs THIS link's env_pubkey
  // bytes under the NEXT link's env_pubkey (the parent).
  const expectedRoot = (input.expectedRootPubkey ?? LEWIS_DEPLOYER_PUBKEY_v1).toLowerCase();

  for (let i = 0; i < chain.length - 1; i++) {
    const link = chain[i];
    const parent = chain[i + 1];
    if (!link?.env_pubkey || !parent?.env_pubkey) {
      return { ok: false, reason: `lineage_link_${i}_malformed` };
    }
    if (!link.parent_signature) {
      return { ok: false, reason: `lineage_link_${i}_missing_parent_signature` };
    }
    // The link's env_pubkey bytes ARE the message signed by the parent.
    const linkPubBytes = hexToBytes(link.env_pubkey);
    const verified = await verifyEd25519(parent.env_pubkey, link.parent_signature, linkPubBytes);
    if (!verified) {
      return { ok: false, reason: `lineage_link_${i}_invalid` };
    }
  }

  const root = chain[chain.length - 1];
  if (!root || (root.env_pubkey ?? "").toLowerCase() !== expectedRoot) {
    return { ok: false, reason: "root_mismatch" };
  }

  // Final: the leaf's env_pubkey verifies the signature header over
  // (nonce ‖ canonical-body-bytes). Nonce is HEX-decoded; first-shot
  // (empty nonce) is allowed but the leaf must still sign the body.
  const leaf = chain[0];
  if (!leaf?.env_pubkey) {
    return { ok: false, reason: "lineage_leaf_missing_pubkey" };
  }
  if (!input.signatureHeader) {
    return { ok: false, reason: "signature_header_missing" };
  }

  let nonceBytes: Uint8Array<ArrayBuffer> = new Uint8Array(new ArrayBuffer(0));
  if (input.nonceHeader && input.nonceHeader.length > 0) {
    try {
      const decoded = hexToBytes(input.nonceHeader);
      const buf = new ArrayBuffer(decoded.length);
      const view = new Uint8Array(buf);
      view.set(decoded);
      nonceBytes = view;
    } catch (e) {
      return { ok: false, reason: `nonce_decode_error: ${(e as Error).message}` };
    }
  }
  const message = new Uint8Array(nonceBytes.length + input.bodyBytes.length);
  message.set(nonceBytes, 0);
  message.set(input.bodyBytes, nonceBytes.length);

  const leafVerified = await verifyEd25519(leaf.env_pubkey, input.signatureHeader, message);
  if (!leafVerified) {
    return { ok: false, reason: "signature_invalid" };
  }

  return { ok: true, leafPubkey: leaf.env_pubkey.toLowerCase(), rootPubkey: root.env_pubkey.toLowerCase() };
}
