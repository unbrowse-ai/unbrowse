/**
 * `unbrowse wallet` — wallet status + lobster.cash resolution introspection.
 *
 * Read-only command. Prints the locally-resolved wallet (provider + masked
 * address + source) alongside the server-side agent profile's wallet, so
 * the user can see whether the local lobster config matches the canonical
 * agent identity. When unconfigured, prints the lobster setup nudge
 * verbatim from src/cli.ts so the call-to-action stays in one voice.
 *
 * Honors the unbrowse delegation boundary documented in
 * src/payments/index.ts: prints lobster's responsibilities (provisioning,
 * signing, broadcast) without claiming any of them for unbrowse.
 */

import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { getWalletContext } from "./payments/wallet.js";
import { getApiKey } from "./client/index.js";
import { DEFAULT_BACKEND_URL } from "./version.js";

const BACKEND_URL = process.env.UNBROWSE_BACKEND_URL || DEFAULT_BACKEND_URL;

function mask(addr: string | undefined): string {
  if (!addr) return "(unset)";
  if (addr.length <= 12) return addr;
  return `${addr.slice(0, 6)}...${addr.slice(-4)}`;
}

function resolutionSource(): {
  source: "env LOBSTER_WALLET_ADDRESS" | "env AGENT_WALLET_ADDRESS" | "~/.lobster/agents.json" | "unconfigured";
  config_path?: string;
} {
  if (process.env.LOBSTER_WALLET_ADDRESS?.trim()) {
    return { source: "env LOBSTER_WALLET_ADDRESS" };
  }
  if (process.env.AGENT_WALLET_ADDRESS?.trim()) {
    return { source: "env AGENT_WALLET_ADDRESS" };
  }
  const lobsterPath = join(process.env.HOME || homedir(), ".lobster", "agents.json");
  if (existsSync(lobsterPath)) {
    return { source: "~/.lobster/agents.json", config_path: lobsterPath };
  }
  return { source: "unconfigured" };
}

interface AgentMeProfile {
  wallet_address?: string | null;
  wallet_provider?: string | null;
  flex_escrow_address?: string | null;
  flex_session_key_address?: string | null;
}

async function fetchAgentProfile(): Promise<AgentMeProfile | null> {
  const key = getApiKey();
  if (!key) return null;
  try {
    const res = await fetch(`${BACKEND_URL}/v1/agents/me`, {
      headers: { Authorization: `Bearer ${key}` },
    });
    if (!res.ok) return null;
    return (await res.json()) as AgentMeProfile;
  } catch {
    return null;
  }
}

function printSetupHint(): void {
  // Verbatim from src/cli.ts so the CTA stays in one voice.
  console.log("");
  console.log("  No payout wallet configured. lobster.cash is the canonical wallet provider for unbrowse:");
  console.log("");
  console.log("    npx @crossmint/lobster-cli setup");
  console.log("");
  console.log("  After setup, run any unbrowse command to auto-publish the wallet to your agent profile.");
  console.log("");
}

export async function cmdWallet(_args: string[], flags: Record<string, unknown>): Promise<void> {
  const local = getWalletContext();
  const res = resolutionSource();
  const verbose = flags.verbose === true || flags.v === true;

  console.log("Local resolution:");
  console.log(`  provider:    ${local.wallet_provider ?? "(unset)"}`);
  console.log(`  address:     ${mask(local.wallet_address)}`);
  console.log(`  source:      ${res.source}`);
  if (res.config_path) {
    console.log(`  config:      ${res.config_path}`);
  }

  const profile = await fetchAgentProfile();
  console.log("");
  console.log("Server-side agent profile:");
  if (!profile) {
    console.log("  (not signed in or backend unreachable; run `unbrowse account --register --email you@example.com`)");
  } else {
    console.log(`  wallet:      ${mask(profile.wallet_address ?? undefined)}`);
    console.log(`  provider:    ${profile.wallet_provider ?? "(unset)"}`);
    console.log(`  flex escrow: ${mask(profile.flex_escrow_address ?? undefined)}`);
    console.log(`  session key: ${mask(profile.flex_session_key_address ?? undefined)}`);

    if (local.wallet_address && !profile.wallet_address) {
      console.log("");
      console.log("  -> local wallet detected; will auto-publish on next authed CLI run.");
    } else if (
      local.wallet_address &&
      profile.wallet_address &&
      local.wallet_address !== profile.wallet_address
    ) {
      console.log("");
      console.log("  WARNING: local wallet differs from server-side. Run `unbrowse account --register --reset-key` to reconcile, or unset LOBSTER_WALLET_ADDRESS to use the server-side value.");
    } else if (local.wallet_address && profile.wallet_address === local.wallet_address) {
      console.log("");
      console.log("  -> local and server-side match.");
    }
  }

  if (verbose) {
    console.log("");
    console.log("Delegation boundary (src/payments/index.ts):");
    console.log("  unbrowse owns: use-case intent, amount, recipient, memo");
    console.log("  lobster owns:  provisioning, signing, broadcast, status");
    console.log("");
    console.log("Reference: https://lobster.cash/docs/skill-compatibility-guide");
  }

  if (res.source === "unconfigured") {
    printSetupHint();
    process.exit(2);
  }
}
