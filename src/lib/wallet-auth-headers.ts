/**
 * wallet-auth-headers.ts — mint the web3-native auth capability for every backend call.
 *
 * IDENTITY ROOT = the wallet pubkey (ed25519). The caller proves key-holdership by
 * signing a fresh domain-separated challenge; the backend verifies the signature and
 * resolves the pubkey → agent_id (`wallet:<pk>` when unbound, the bound account
 * otherwise). This is web3-native and NEVER key-gated: a wallet with no api-key is a
 * full principal. The api-key Bearer is a DEPRECATED OPTIONAL web2 wrapper, sent only
 * when a legacy key happens to be present so existing account-bound flows (earnings
 * accrual, dashboards) keep working until the wrapper is fully retired. The wallet
 * signature alone is sufficient — callers MUST NOT gate on key presence.
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
 * The remote-request auth header set: the wallet capability is the SOLE REQUIRED
 * credential (always sent when a signer exists — and a signer always exists after
 * first run, see ensureLocalWalletAddress). The api-key Bearer is a DEPRECATED
 * OPTIONAL web2 wrapper, sent only when a legacy key is present for account-bound
 * flow continuity. Web3-native, never key-gated: a key-less wallet authenticates
 * fully; a keyed wallet sends both during the wrapper's retirement window. Used by
 * the client transport for every outbound beta-api call.
 */
export async function mergedAuthHeaders(key?: string, signer?: ThinClientSigner): Promise<Record<string, string>> {
  const wallet = (await walletAuthHeaders(signer)) ?? {};
  return {
    ...wallet,
    ...(key ? { Authorization: `Bearer ${key}` } : {}),
  };
}
