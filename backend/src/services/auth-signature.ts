/**
 * Signature-based agent auth (web3-PK root) — increment 2 of the auth re-root.
 *
 * A caller proves they hold the wallet private key by signing a fresh, domain-
 * separated challenge; the server verifies the ed25519 signature and resolves the
 * pubkey → the SAME agent_id the bound api-key has (keys.ts `keyIdForPubkey`). This
 * is the path that makes the PK the load-bearing identity root; the api-key becomes
 * its web2 convenience wrapper. ADDITIVE: this is a standalone resolver; wiring it
 * into bearerAuth (before the 401) is the integration step and never changes the
 * existing key path.
 *
 * Replay defense: the challenge embeds a timestamp; signatures older/newer than
 * AUTH_TTL_MS are rejected. Domain separation (AUTH_DOMAIN) stops a contract-path
 * signature from being replayed as an auth signature and vice-versa.
 */
import type { Env } from "../types.js";
import { keyIdForPubkey } from "./keys.js";

const AUTH_DOMAIN = "unbrowse-auth:v1";
const AUTH_TTL_MS = 60_000; // signature freshness window

function hexToBytes(hex: string): Uint8Array {
  const clean = hex.startsWith("0x") ? hex.slice(2) : hex;
  if (clean.length % 2 !== 0) throw new Error("odd-length hex");
  const out = new Uint8Array(clean.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(clean.substring(i * 2, i * 2 + 2), 16);
  return out;
}

/** The exact bytes the client must sign: domain + pubkey + timestamp. */
export function authChallenge(pubkeyHex: string, ts: string): string {
  return `${AUTH_DOMAIN}:${pubkeyHex}:${ts}`;
}

/** Native Web-Crypto ed25519 verify (same idiom as declare-signature). Never throws. */
export async function verifyEd25519(pubkeyHex: string, message: string, sigHex: string): Promise<boolean> {
  try {
    const pub = hexToBytes(pubkeyHex);
    if (pub.length !== 32) return false;
    const sig = hexToBytes(sigHex);
    if (sig.length !== 64) return false;
    const key = await crypto.subtle.importKey("raw", pub, { name: "Ed25519" }, false, ["verify"]);
    return await crypto.subtle.verify({ name: "Ed25519" }, key, sig, new TextEncoder().encode(message));
  } catch {
    return false;
  }
}

export interface SignatureAuthInput { pubkeyHex: string; ts: string; sigHex: string }

/**
 * Authenticate a request by wallet signature. Returns the bound `agent_id` (the
 * SAME as the api-key's) or null (→ caller falls through to key/anon). Order:
 * fresh-ts (replay) → ed25519 verify → pubkey→agent binding.
 */
export async function authBySignature(
  env: Env,
  input: SignatureAuthInput,
  now: number = Date.now(),
): Promise<{ agent_id: string } | null> {
  const tsNum = Date.parse(input.ts);
  if (!Number.isFinite(tsNum) || Math.abs(now - tsNum) > AUTH_TTL_MS) return null; // stale / replay
  const ok = await verifyEd25519(input.pubkeyHex, authChallenge(input.pubkeyHex, input.ts), input.sigHex);
  if (!ok) return null;
  const agentId = await keyIdForPubkey(env, input.pubkeyHex);
  if (!agentId) return null; // pubkey not bound to an agent → not a signature-auth principal
  return { agent_id: agentId };
}
