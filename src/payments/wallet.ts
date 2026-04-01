/**
 * WalletProvider — abstract interface for wallet plugins (e.g. lobster.cash).
 *
 * Unbrowse owns: describing the interface contract.
 * Wallet plugins (lobster.cash, etc.) own: implementing connect/sign/broadcast.
 */
export interface WalletProvider {
  name: string;
  connect(): Promise<{ address: string }>;
  disconnect(): Promise<void>;
  signTransaction(tx: unknown): Promise<string>;
  getBalance(): Promise<bigint>;
}

/**
 * Wallet precheck — lobster.cash compatible.
 *
 * This module only checks whether the agent has a wallet configured.
 * It does NOT generate wallets, manage keys, or call wallet APIs.
 * Wallet provisioning and transaction execution are owned by
 * the agent's wallet plugin (e.g. lobster.cash).
 */
export type WalletCheckResult = {
  configured: boolean;
  provider?: string;
};

/**
 * Check if the agent has a wallet configured.
 *
 * Looks for wallet context signals that a wallet plugin would set.
 * Does NOT create or modify wallet state.
 */
export function checkWalletConfigured(): WalletCheckResult {
  // lobster.cash plugin sets these when wallet is paired
  if (process.env.LOBSTER_WALLET_ADDRESS) {
    return { configured: true, provider: "lobster.cash" };
  }

  // Generic wallet context (other providers)
  if (process.env.AGENT_WALLET_ADDRESS) {
    return { configured: true, provider: process.env.AGENT_WALLET_PROVIDER ?? "unknown" };
  }

  return { configured: false };
}
