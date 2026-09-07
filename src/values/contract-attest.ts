/**
 * contract-attest — the CLI↔server native bind: a single-link spawn attestation rooted at the
 * aiko SUBSTRATE deployer identity.
 *
 * The CLI already wallet-signs each declare (signer.ts → a per-declare body signature). This adds
 * the SECOND, mutual half: the CLI proves it is the aiko substrate's own lineage by signing the
 * declare body with the aiko DEPLOYER key (~/.aiko/keys/root.key) and sending a single-link
 * lineage chain whose root == leaf == the deployer identity. The server's attestation gate
 * (backend/src/lib/attestation.ts) verifies the chain terminus == LEWIS_DEPLOYER_PUBKEY_v1 and the
 * leaf signs the body — so the CLI and server recognize EACH OTHER by one wallet-signed /contract
 * identity, not a bearer key.
 *
 * Single-link by design (Lewis 2026-06-23): leaf == root == the aiko deployer, so there is no
 * parent link to verify — the chain IS the substrate root. Only the machine holding root.key (whose
 * pubkey is AIKO_DEPLOYER_ROOT_PUBKEY) can produce it; every other install returns null here and
 * stays on the legacy-anonymous path (the server admits those unchanged). Fail-closed on a rotated
 * key: if root.key no longer derives to the pinned pubkey, we send NO headers (avoids a 401 the
 * server would raise for a present-but-invalid attestation).
 */
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import nacl from "tweetnacl";

/** The aiko substrate deployer identity = Ed25519(~/.aiko/keys/root.key seed), current post-20-Jun
 *  rotation. The server pins this as LEWIS_DEPLOYER_PUBKEY_v1. (root.pub on disk is STALE.) */
export const AIKO_DEPLOYER_ROOT_PUBKEY =
  "e6837faf6c4687968f831a421586712d33fc7fc67c3f091bc1d02e856b98b2fc";

export interface SpawnAttestationHeaders {
  "x-aiko-lineage-chain": string;
  "x-aiko-spawn-signature": string;
  "x-aiko-spawn-nonce": string;
}

/** The default deployer-seed reader: the raw hex contents of ~/.aiko/keys/root.key (or null when
 *  absent — the common case on a non-deployer install). Injectable so the fail-closed branches are
 *  witnessable without touching the real key. */
export function defaultDeployerSeedHex(): string | null {
  try {
    return readFileSync(join(homedir(), ".aiko", "keys", "root.key"), "utf8");
  } catch {
    return null;
  }
}

/**
 * Build the single-link spawn-attestation headers over the EXACT `bodyBytes` the CLI will POST.
 * Returns null when this machine cannot produce the substrate-root attestation (no key, or a
 * rotated key that no longer matches the pinned pubkey) — the caller then sends no headers and the
 * server admits the declare on the legacy-anonymous path. `contractId` labels the single link;
 * `loadSeedHex` is the deployer-seed reader (injectable for the fail-closed witness).
 */
export function buildSpawnAttestation(
  bodyBytes: Uint8Array,
  contractId = "cli-server-bind",
  loadSeedHex: () => string | null = defaultDeployerSeedHex,
): SpawnAttestationHeaders | null {
  let seedHex: string | null;
  try {
    seedHex = loadSeedHex();
  } catch {
    seedHex = null;
  }
  if (!seedHex) return null; // no deployer key → legacy-anonymous (every non-Lewis install)
  let kp: nacl.SignKeyPair;
  try {
    const seed = Buffer.from(seedHex.trim(), "hex");
    if (seed.length < 32) return null;
    kp = nacl.sign.keyPair.fromSeed(seed.subarray(0, 32));
  } catch {
    return null;
  }
  const pubHex = Buffer.from(kp.publicKey).toString("hex");
  // Fail-closed: a rotated root.key whose pubkey ≠ the pinned root would 401 server-side. Don't send.
  if (pubHex !== AIKO_DEPLOYER_ROOT_PUBKEY) return null;

  // Single link: leaf == root == the aiko deployer. No parent → no parent_signature to verify.
  const chain = [{ contract_id: contractId, env_pubkey: pubHex, parent_id: null, parent_signature: null }];
  const lineage = Buffer.from(JSON.stringify(chain), "utf8").toString("base64url");

  // First-shot: empty nonce. The leaf signs (nonce ‖ bodyBytes) — here just bodyBytes.
  const sig = nacl.sign.detached(bodyBytes, kp.secretKey);
  return {
    "x-aiko-lineage-chain": lineage,
    "x-aiko-spawn-signature": Buffer.from(sig).toString("hex"),
    "x-aiko-spawn-nonce": "",
  };
}
