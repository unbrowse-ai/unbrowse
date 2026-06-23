/**
 * wallet-auth-headers.ts — mint the web3-native auth capability for every backend call.
 *
 * The auth credential is a signed capability whose ROOT is the wallet pubkey (sp-zkaccess
 * `witness` atom: prove you hold the key by signing a fresh domain-separated challenge;
 * the verifier re-checks against the pubkey, no central authority). The api-key bearer is a
 * delegated convenience WRAPPER on top — these headers ride ALONGSIDE it, never instead of
 * the key. The backend (auth-signature.ts) authenticates the wallet sig FIRST and treats an
 * unbound wallet as the principal `wallet:<pk>`, so identity is never key-gated.
 *
 * Challenge MUST match the backend verbatim: AUTH_DOMAIN ":" pubkeyHex ":" ts (auth-signature.ts).
 */
import type { ThinClientSigner } from "./contract-thin-client.js";

const AUTH_DOMAIN = "unbrowse-auth:v1"; // keep in lockstep with backend auth-signature.ts

function toHex(b: Uint8Array): string {
  let s = "";
  for (const x of b) s += x.toString(16).padStart(2, "0");
  return s;
}

/** The exact bytes the client signs (mirrors the backend's `authChallenge`). */
export function authChallenge(pubkeyHex: string, ts: string): string {
  return `${AUTH_DOMAIN}:${pubkeyHex}:${ts}`;
}

export interface WalletAuthHeaders {
  "X-Unbrowse-Wallet": string;
  "X-Unbrowse-Auth-Ts": string;
  "X-Unbrowse-Signature": string;
}

/**
 * Build the wallet-signature auth headers from the ambient identity signer. Best-effort:
 * returns null (caller proceeds with the key/anon wrapper) when no signer is available or
 * signing fails — never throws into the request path. `signer` is injectable for tests; in
 * production it lazy-loads the real `defaultSigner` so importing this module is cheap.
 */
export async function walletAuthHeaders(signer?: ThinClientSigner): Promise<WalletAuthHeaders | null> {
  try {
    const s = signer ?? (await import("./contract-thin-client.js")).defaultSigner;
    const resolved = typeof s === "function" ? await (s as () => Promise<ThinClientSigner | null>)() : s;
    if (!resolved) return null;
    const pub = await resolved.getWalletPubkey();
    if (!pub || pub.length !== 32) return null;
    const pubkeyHex = toHex(pub);
    const ts = new Date().toISOString();
    const { signature } = await resolved.signBytes(new TextEncoder().encode(authChallenge(pubkeyHex, ts)));
    if (!signature || signature.length !== 64) return null;
    return {
      "X-Unbrowse-Wallet": pubkeyHex,
      "X-Unbrowse-Auth-Ts": ts,
      "X-Unbrowse-Signature": toHex(signature),
    };
  } catch {
    return null; // signing unavailable → fall through to the key/anon wrapper
  }
}

/**
 * The remote-request auth header set: the wallet capability is PRIMARY (always sent when a
 * signer exists), the api-key bearer is the DELEGATED convenience grant layered on top (sent
 * only when present). Web3-native, never key-gated: a key-less wallet still authenticates;
 * a keyed wallet sends both (the backend authenticates the signature first, the key links the
 * web2 account). Used by the client transport for every outbound beta-api call.
 */
export async function mergedAuthHeaders(key?: string, signer?: ThinClientSigner): Promise<Record<string, string>> {
  const wallet = (await walletAuthHeaders(signer)) ?? {};
  return {
    ...wallet,
    ...(key ? { Authorization: `Bearer ${key}` } : {}),
  };
}
