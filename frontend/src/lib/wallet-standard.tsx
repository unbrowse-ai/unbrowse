"use client";

/**
 * Wallet Standard (open-wallet-standard) connect surface for the Unbrowse web app.
 *
 * The frontend had no Solana wallet-connect — Privy was Ethereum-side, and
 * payments were CLI/backend only. This is the browser counterpart to the SDK's
 * `unbrowse/sdk/wallet-standard` bridge: discover any Wallet Standard Solana
 * wallet (Phantom, Solflare, Backpack, a Privy embedded Solana wallet,
 * lobster.cash, …), connect, and sign the x402 payment challenge into an
 * `X-PAYMENT` header for a priced Unbrowse call.
 *
 * Keys never leave the wallet — we prepare the payment intent and delegate
 * signing/approval/broadcast to the wallet (lobster.cash-compatible).
 */
import { useEffect, useState, useCallback } from "react";
import { getWallets } from "@wallet-standard/app";
import type { Wallet, WalletAccount } from "@wallet-standard/base";

const SOLANA = "solana:";
const F_CONNECT = "standard:connect";
const F_SIGN_MESSAGE = "solana:signMessage";

type ConnectFeature = { connect(input?: { silent?: boolean }): Promise<{ accounts: readonly WalletAccount[] }> };
type SignMessageFeature = {
  signMessage(input: { account: WalletAccount; message: Uint8Array }): Promise<
    ReadonlyArray<{ signedMessage: Uint8Array; signature: Uint8Array }>
  >;
};

/** Wallets that can connect + sign a Solana message (what x402 over Solana needs). */
export function discoverSolanaWallets(): readonly Wallet[] {
  return getWallets()
    .get()
    .filter((w) => w.chains.some((c) => c.startsWith(SOLANA)) && F_SIGN_MESSAGE in w.features);
}

/** Live list of Wallet Standard Solana wallets (re-reads as wallets register). */
export function useSolanaWallets(): readonly Wallet[] {
  const [wallets, setWallets] = useState<readonly Wallet[]>([]);
  useEffect(() => {
    const refresh = () => setWallets(discoverSolanaWallets());
    refresh();
    const { on } = getWallets();
    const offRegister = on("register", refresh);
    const offUnregister = on("unregister", refresh);
    return () => {
      offRegister();
      offUnregister();
    };
  }, []);
  return wallets;
}

function toBase64(bytes: Uint8Array): string {
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s);
}

function paymentMessage(terms: Record<string, unknown> | null): Uint8Array {
  let challenge = "";
  if (terms) {
    const accepts = Array.isArray(terms.accepts) ? (terms.accepts[0] as Record<string, unknown>) : undefined;
    challenge =
      (typeof terms.challenge === "string" && terms.challenge) ||
      (typeof terms.message === "string" && terms.message) ||
      (accepts && typeof accepts.challenge === "string" && accepts.challenge) ||
      JSON.stringify(accepts ?? terms);
  }
  return new TextEncoder().encode(challenge);
}

/** Connect a wallet (prompts the user) and return its first account. */
export async function connectWallet(wallet: Wallet): Promise<WalletAccount | null> {
  if (wallet.accounts[0]) return wallet.accounts[0];
  const connect = wallet.features[F_CONNECT] as ConnectFeature | undefined;
  if (!connect) return null;
  const { accounts } = await connect.connect();
  return accounts[0] ?? null;
}

/**
 * Sign an x402 payment challenge with a connected wallet and return the
 * `X-PAYMENT` header value for a single retry of the priced request. Returns
 * `null` if the wallet cannot sign — the caller keeps the original 402.
 */
export async function payWith(
  wallet: Wallet,
  terms: Record<string, unknown> | null,
  account?: WalletAccount,
): Promise<Record<string, string> | null> {
  const sign = wallet.features[F_SIGN_MESSAGE] as SignMessageFeature | undefined;
  if (!sign) return null;
  const acct = account ?? (await connectWallet(wallet));
  if (!acct) return null;
  const [res] = await sign.signMessage({ account: acct, message: paymentMessage(terms) });
  if (!res) return null;
  return { "X-PAYMENT": toBase64(res.signature) };
}
