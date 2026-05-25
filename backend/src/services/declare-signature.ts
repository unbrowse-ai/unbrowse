/**
 * Verify ed25519 signatures on /v1/contract/declare bodies — the substrate's
 * write-side identity gate.
 *
 * Canonical signed body: a stable JSON projection of (plan, action, parent_id,
 * agent, wallet_identity, ts) with sorted keys. Caller signs the bytes of that
 * projection with their wallet's ed25519 private key; declare_signature is the
 * hex-encoded 64-byte signature. The server verifies via Web Crypto's native
 * Ed25519 algorithm (supported on CF Workers since 2023).
 *
 * Why this matters: before this gate, anyone could POST /v1/contract/declare
 * with any `agent` field they wanted, polluting the ledger under any
 * identity. With this gate, only the holder of the registered ed25519 private
 * key for a given wallet_identity pubkey can write rows under that pubkey.
 *
 * Backwards compat: unsigned declares are accepted but auto-coerced to
 * agent="anonymous" + visibility="public" so legacy callers keep working
 * without an upgrade path. Signed declares get the full trust path.
 *
 * Reality parallel: cryptographic signatures = molecular tags on a signaling
 * molecule. A cell only receives a signal whose molecular signature matches
 * its receptor. Mismatched signal = ignored. Same shape here.
 */

/** Canonical signed body — stable JSON projection of declare-write inputs. */
export interface CanonicalDeclareBody {
  plan: string;
  action: string;
  parent_id: string | null;
  agent: string | null;
  wallet_identity: string;
  ts: string;
}

/**
 * Serialize the canonical signed body. Keys are emitted in fixed order so
 * client and server agree on the exact bytes being signed.
 */
export function canonicalizeDeclareBody(body: CanonicalDeclareBody): string {
  return JSON.stringify({
    plan: body.plan,
    action: body.action,
    parent_id: body.parent_id,
    agent: body.agent,
    wallet_identity: body.wallet_identity,
    ts: body.ts,
  });
}

function hexToBytes(hex: string): Uint8Array {
  const clean = hex.startsWith("0x") ? hex.slice(2) : hex;
  if (clean.length % 2 !== 0) throw new Error("hex string must have even length");
  const out = new Uint8Array(clean.length / 2);
  for (let i = 0; i < out.length; i++) {
    out[i] = parseInt(clean.substring(i * 2, i * 2 + 2), 16);
  }
  return out;
}

/**
 * Verify an ed25519 signature over the canonical declare body. Returns true
 * iff the signature is valid for the given pubkey + body. Catches any
 * Web Crypto exception (malformed key, malformed signature, length mismatch)
 * and returns false rather than throwing — the caller treats unverified the
 * same as unsigned (auto-coerce path).
 */
export async function verifyDeclareSignature(
  body: CanonicalDeclareBody,
  signatureHex: string,
): Promise<boolean> {
  try {
    const pubkeyBytes = hexToBytes(body.wallet_identity);
    if (pubkeyBytes.length !== 32) return false;
    const sigBytes = hexToBytes(signatureHex);
    if (sigBytes.length !== 64) return false;
    const canonical = canonicalizeDeclareBody(body);
    const dataBytes = new TextEncoder().encode(canonical);
    const key = await crypto.subtle.importKey(
      "raw",
      pubkeyBytes,
      { name: "Ed25519" },
      false,
      ["verify"],
    );
    return await crypto.subtle.verify({ name: "Ed25519" }, key, sigBytes, dataBytes);
  } catch {
    return false;
  }
}
