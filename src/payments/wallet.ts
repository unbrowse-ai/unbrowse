import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { resolveOwsWalletAddress } from "./ows.js";

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

type WalletContext = {
  wallet_address?: string;
  wallet_provider?: string;
};

type LobsterAgentRecord = {
  walletAddress?: unknown;
  wallet_address?: unknown;
  authorizedWallets?: {
    solana?: unknown;
    [key: string]: unknown;
  };
};

type LobsterAgentsFile = {
  activeAgentId?: unknown;
  agents?: Record<string, LobsterAgentRecord> | LobsterAgentRecord[];
};

function asNonEmptyString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function getLobsterWalletFromLocalConfig(): string | undefined {
  const agentsPath = join(process.env.HOME || homedir(), ".lobster", "agents.json");
  if (!existsSync(agentsPath)) return undefined;

  try {
    const raw = JSON.parse(readFileSync(agentsPath, "utf8")) as LobsterAgentsFile;
    const activeAgentId = asNonEmptyString(raw.activeAgentId);
    const activeAgent = Array.isArray(raw.agents)
      ? raw.agents.find((agent) => asNonEmptyString((agent as { id?: unknown }).id) === activeAgentId)
      : activeAgentId
        ? raw.agents?.[activeAgentId]
        : undefined;

    return asNonEmptyString(activeAgent?.authorizedWallets?.solana)
      ?? asNonEmptyString(activeAgent?.walletAddress)
      ?? asNonEmptyString(activeAgent?.wallet_address);
  } catch {
    return undefined;
  }
}

export function getWalletContext(): WalletContext {
  // OWS (Open Wallet Standard) is the primary, open-standard wallet path — preferred
  // over lobster.cash. An explicit OWS_WALLET_ADDRESS or a wallet in the ~/.ows vault wins.
  // The vault probe is gated by the same flag tests use to assert a pristine machine.
  const owsDisabled = process.env.UNBROWSE_DISABLE_LOCAL_WALLET === "1";
  const ows = resolveOwsWalletAddress({ probeVault: !owsDisabled });
  if (ows) {
    return { wallet_address: ows, wallet_provider: "ows" };
  }

  const lobsterWallet = asNonEmptyString(process.env.LOBSTER_WALLET_ADDRESS);
  if (lobsterWallet) {
    return { wallet_address: lobsterWallet, wallet_provider: "lobster.cash" };
  }

  const genericWallet = asNonEmptyString(process.env.AGENT_WALLET_ADDRESS);
  if (genericWallet) {
    return {
      wallet_address: genericWallet,
      wallet_provider: asNonEmptyString(process.env.AGENT_WALLET_PROVIDER),
    };
  }
  // Skip local lobster config probe when UNBROWSE_DISABLE_LOCAL_WALLET=1.
  // Tests that want "no wallet configured" set this explicitly so they don't
  // pick up the developer's actual ~/.lobster/config.json.
  if (!owsDisabled) {
    const localLobsterWallet = getLobsterWalletFromLocalConfig();
    if (localLobsterWallet) {
      return { wallet_address: localLobsterWallet, wallet_provider: "lobster.cash" };
    }
  }

  return {};
}

/**
 * Check if the agent has a wallet configured.
 *
 * Looks for wallet context signals that a wallet plugin would set.
 * Does NOT create or modify wallet state.
 */
export function checkWalletConfigured(): WalletCheckResult {
  const wallet = getWalletContext();
  if (!wallet.wallet_address) return { configured: false };
  return {
    configured: true,
    provider: wallet.wallet_provider ?? "unknown",
  };
}
