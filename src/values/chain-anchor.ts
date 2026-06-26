/**
 * chain-anchor — write ZK commitments to the IQ on-chain ledger.
 *
 * Provides anchoring functions for the three ZK commitment types:
 * 1. ZK binding commitments (credential binding point y + wallet sig)
 * 2. Proof-of-indexing Merkle roots
 * 3. Sealed-cache value commitments
 *
 * Each anchor writes to a dedicated IQ namespace, fail-open. The commitment
 * is the pointer (value off-chain, root on-chain) — per the crypto paper's
 * "Sign Everything" thesis and the onchain-firmament boundary (firmament 2:
 * value/pointer line).
 */
import { resolutionLedgerFromEnv } from "./iq-ledger.js";

export type AnchorNamespace = "ubz-zk-bind" | "ubz-poi" | "ubz-sealed";

export interface AnchorResult {
  anchored: boolean;
  namespace: AnchorNamespace;
  intent: string;
  note?: string;
}

async function anchorToChain(
  namespace: AnchorNamespace,
  intent: string,
  value: unknown,
  env: Record<string, string | undefined> = process.env,
): Promise<AnchorResult> {
  try {
    const ledger = await resolutionLedgerFromEnv(env);
    if (!ledger) {
      return { anchored: false, namespace, intent, note: "IQ not configured" };
    }
    await ledger.append(`${namespace}:${intent}`, JSON.stringify(value));
    return { anchored: true, namespace, intent };
  } catch (e) {
    return {
      anchored: false,
      namespace,
      intent,
      note: e instanceof Error ? e.message : String(e),
    };
  }
}

/**
 * Anchor a ZK binding commitment on-chain.
 * The binding `{y, root, sig}` proves credential ownership without revealing the credential.
 * On-chain, only the public commitment (y + wallet root) is stored — the credential stays local.
 */
export async function anchorZkBinding(
  bindingY: string,
  walletRoot: string,
  walletSig: string,
  domain?: string,
): Promise<AnchorResult> {
  const intent = `zk-bind:${bindingY.slice(0, 16)}`;
  return anchorToChain("ubz-zk-bind", intent, {
    y: bindingY,
    root: walletRoot,
    sig: walletSig,
    domain: domain ?? null,
    ts: Date.now(),
  });
}

/**
 * Anchor a Proof-of-Indexing Merkle root on-chain.
 * The root commits to the set of indexed routes without revealing the route values.
 */
export async function anchorPoiRoot(
  merkleRoot: string,
  routePtr: string,
  schemaHash: string,
  walletSig?: string,
): Promise<AnchorResult> {
  const intent = `poi:${routePtr}`;
  return anchorToChain("ubz-poi", intent, {
    merkleRoot,
    routePtr,
    schemaHash,
    sig: walletSig ?? null,
    ts: Date.now(),
  });
}

/**
 * Anchor a sealed-cache commitment on-chain.
 * The commitment (sha256 of plaintext) is the pointer — value stays off-chain,
 * encrypted under the wallet's HKDF-derived key.
 */
export async function anchorSealedCommitment(
  commitment: string,
  key: string,
  walletRoot?: string,
): Promise<AnchorResult> {
  const intent = `sealed:${key}`;
  return anchorToChain("ubz-sealed", intent, {
    commitment,
    key,
    walletRoot: walletRoot ?? null,
    ts: Date.now(),
  });
}
