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
export type Bytes = Uint8Array;
export interface WsAccount {
    readonly address: string;
    readonly publicKey: Bytes;
    readonly chains: readonly string[];
    readonly features: readonly string[];
    readonly label?: string;
}
export interface WsConnectFeature {
    connect(input?: {
        silent?: boolean;
    }): Promise<{
        accounts: readonly WsAccount[];
    }>;
}
export interface WsSignMessageFeature {
    signMessage(input: {
        account: WsAccount;
        message: Bytes;
    }): Promise<ReadonlyArray<{
        signedMessage: Bytes;
        signature: Bytes;
    }>>;
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
/** Wallets that can connect + sign a Solana message (what x402 over Solana needs). */
export declare function pickSolanaWallets(wallets: readonly WsWallet[]): WsWallet[];
/**
 * The bytes a wallet signs for an x402 payment. The server advertises the
 * challenge in the 402 `terms` (an `accepts`/`flex`/`x402` envelope); we surface
 * the common shapes and sign the canonical challenge string. The exact on-wire
 * payload assembly is owned by the x402 facilitator the server names — this
 * produces the message to authorize.
 */
export declare function paymentMessage(terms: PaymentRequired["terms"]): Bytes;
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
export declare function walletStandardPay(wallet: WsWallet, opts?: WalletStandardPayOptions): PayHandler;
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
export declare function makeUnbrowseWallet(opts: UnbrowseWalletOptions): WsWallet;
