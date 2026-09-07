/**
 * Wallet Standard (open-wallet-standard / `@wallet-standard`) bridge for the
 * Unbrowse SDK — turns ANY Wallet Standard wallet (Phantom, Solflare, Backpack,
 * a Privy embedded Solana wallet, lobster.cash, …) into a {@link PayHandler}
 * that transparently satisfies an HTTP 402 over x402.
 *
 * Dependency-free by design: this module describes the *minimal* Wallet Standard
 * shapes it consumes structurally — it does NOT import `@wallet-standard/*`, so
 * the shipped SDK stays zero-dep and browser-safe. Pass any object that
 * conforms (the real `@wallet-standard` `Wallet` does) and it just works.
 *
 * Delegation boundary: this bridge prepares the payment *intent* (the bytes to
 * sign) and hands signing to the wallet. The wallet owns provisioning, approval,
 * signing, and broadcast — we never touch keys. Web2 users who "just want to pay
 * via API" can opt into {@link makeUnbrowseWallet}, an optional default wallet
 * that delegates signing to the Unbrowse server via an API key.
 */
import type { PayHandler, PaymentRequired } from "./fetch.js";

// ── Minimal Wallet Standard shapes (structural; mirrors @wallet-standard/base
//    + @solana/wallet-standard-features). Consume the real types freely. ──────

export type Bytes = Uint8Array;

export interface WsAccount {
  readonly address: string; // base58 (Solana)
  readonly publicKey: Bytes;
  readonly chains: readonly string[];
  readonly features: readonly string[];
  readonly label?: string;
}

export interface WsConnectFeature {
  connect(input?: { silent?: boolean }): Promise<{ accounts: readonly WsAccount[] }>;
}
export interface WsSignMessageFeature {
  signMessage(input: { account: WsAccount; message: Bytes }): Promise<
    ReadonlyArray<{ signedMessage: Bytes; signature: Bytes }>
  >;
}

/** The subset of a Wallet Standard `Wallet` this bridge uses. */
export interface WsWallet {
  readonly version: string;
  readonly name: string;
  readonly icon?: string;
  readonly chains: readonly string[];
  readonly accounts: readonly WsAccount[];
  readonly features: Record<string, unknown> & {
    "standard:connect"?: WsConnectFeature;
    "solana:signMessage"?: WsSignMessageFeature;
  };
}

const SOLANA = "solana:";
const F_CONNECT = "standard:connect";
const F_SIGN_MESSAGE = "solana:signMessage";

/** Wallets that can connect + sign a Solana message (what x402 over Solana needs). */
export function pickSolanaWallets(wallets: readonly WsWallet[]): WsWallet[] {
  return wallets.filter(
    (w) =>
      w.chains.some((c) => c.startsWith(SOLANA)) &&
      F_SIGN_MESSAGE in w.features,
  );
}

function toBase64(bytes: Bytes): string {
  // browser + node, no deps
  if (typeof btoa === "function") {
    let s = "";
    for (const b of bytes) s += String.fromCharCode(b);
    return btoa(s);
  }
  // @ts-ignore Buffer exists in node
  return Buffer.from(bytes).toString("base64");
}

/**
 * The bytes a wallet signs for an x402 payment. The server advertises the
 * challenge in the 402 `terms` (an `accepts`/`flex`/`x402` envelope); we surface
 * the common shapes and sign the canonical challenge string. The exact on-wire
 * payload assembly is owned by the x402 facilitator the server names — this
 * produces the message to authorize.
 */
export function paymentMessage(terms: PaymentRequired["terms"]): Bytes {
  let challenge = "";
  if (terms && typeof terms === "object") {
    const t = terms as Record<string, unknown>;
    const accepts = Array.isArray(t.accepts) ? (t.accepts[0] as Record<string, unknown> | undefined) : undefined;
    challenge =
      (typeof t.challenge === "string" && t.challenge) ||
      (typeof t.message === "string" && t.message) ||
      (accepts && typeof accepts.challenge === "string" && accepts.challenge) ||
      JSON.stringify(accepts ?? t);
  }
  return new TextEncoder().encode(challenge);
}

export interface WalletStandardPayOptions {
  /** Which account to pay from (defaults to the wallet's first account). */
  account?: WsAccount;
  /** Header name the server expects (default `X-PAYMENT`, the x402 standard). */
  header?: string;
}

/**
 * Build a {@link PayHandler} from any Wallet Standard wallet. On a 402 it asks
 * the wallet to sign the payment challenge and returns the `X-PAYMENT` header
 * for a single retry. Returns `null` (declines) if the wallet cannot sign — the
 * caller then sees the original 402, never a thrown error.
 *
 *   import { Unbrowse } from "unbrowse/sdk";
 *   import { walletStandardPay } from "unbrowse/sdk/wallet-standard";
 *   const pay = walletStandardPay(myWallet);
 *   const unbrowse = new Unbrowse({ apiKey, pay });
 */
export function walletStandardPay(wallet: WsWallet, opts: WalletStandardPayOptions = {}): PayHandler {
  const header = opts.header ?? "X-PAYMENT";
  return async (ctx: PaymentRequired): Promise<HeadersInit | null> => {
    const sign = wallet.features[F_SIGN_MESSAGE] as WsSignMessageFeature | undefined;
    if (!sign) return null; // wallet can't sign Solana messages → decline cleanly

    let account = opts.account ?? wallet.accounts[0];
    if (!account) {
      const connect = wallet.features[F_CONNECT] as WsConnectFeature | undefined;
      if (!connect) return null;
      const { accounts } = await connect.connect();
      account = accounts[0];
      if (!account) return null;
    }

    const message = paymentMessage(ctx.terms);
    const [result] = await sign.signMessage({ account, message });
    if (!result) return null;
    return { [header]: toBase64(result.signature) };
  };
}

// ── Optional unbrowse-default wallet (for web2 "just pay via API" users) ──────

export interface UnbrowseWalletOptions {
  /** Required to opt in — signing is delegated to the Unbrowse server. */
  apiKey: string;
  /** The agent's Solana address (base58) the server signs for. */
  address: string;
  /** The agent's public key bytes. */
  publicKey: Bytes;
  /** Server base URL (defaults to the hosted Unbrowse API). */
  baseUrl?: string;
  /** Injected fetch (defaults to platform fetch); keeps this testable + zero-dep. */
  fetch?: typeof fetch;
}

const DEFAULT_BASE = "https://beta-api.unbrowse.ai";

/**
 * An OPTIONAL default wallet for users who don't want to run their own wallet —
 * a Wallet Standard `Wallet` whose signing is delegated to the Unbrowse server
 * (authorized by an API key). It is opt-in: you must pass an `apiKey`. Register
 * it with `@wallet-standard/wallet`'s `registerWallet()` to expose it to any
 * Wallet Standard consumer (including the Unbrowse frontend).
 *
 * Web2-native: the user "just wants to pay via API" — no seed phrase, no
 * extension. The server (or lobster.cash, or any other wallet) remains the
 * transaction-state authority; this is a thin convenience default, never forced.
 */
export function makeUnbrowseWallet(opts: UnbrowseWalletOptions): WsWallet {
  if (!opts.apiKey) {
    throw new Error("makeUnbrowseWallet is opt-in: pass { apiKey } to delegate signing to the Unbrowse server.");
  }
  const base = (opts.baseUrl ?? DEFAULT_BASE).replace(/\/$/, "");
  const doFetch = opts.fetch ?? (globalThis.fetch as typeof fetch);
  const account: WsAccount = {
    address: opts.address,
    publicKey: opts.publicKey,
    chains: ["solana:mainnet"],
    features: [F_SIGN_MESSAGE],
  };
  const signMessage: WsSignMessageFeature["signMessage"] = async ({ message }) => {
    const res = await doFetch(`${base}/v1/wallet/sign`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${opts.apiKey}` },
      body: JSON.stringify({ address: opts.address, message: toBase64(message) }),
    });
    if (!res.ok) throw new Error(`unbrowse wallet sign failed: ${res.status}`);
    const data = (await res.json()) as { signature: string };
    const sig = Uint8Array.from(atobBytes(data.signature));
    return [{ signedMessage: message, signature: sig }];
  };
  return {
    version: "1.0.0",
    name: "Unbrowse",
    chains: ["solana:mainnet"],
    accounts: [account],
    features: {
      [F_CONNECT]: { connect: async () => ({ accounts: [account] }) } as WsConnectFeature,
      [F_SIGN_MESSAGE]: { signMessage } as WsSignMessageFeature,
    },
  };
}

function atobBytes(b64: string): number[] {
  const bin = typeof atob === "function" ? atob(b64) : // @ts-ignore
    Buffer.from(b64, "base64").toString("binary");
  const out: number[] = [];
  for (let i = 0; i < bin.length; i++) out.push(bin.charCodeAt(i));
  return out;
}
