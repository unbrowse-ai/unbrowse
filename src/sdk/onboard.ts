/**
 * src/sdk/onboard.ts — identity onboarding for the agent.
 *
 * Credential chain, resolved in order:
 *   1. a BOUND ACCOUNT API key, when explicitly configured.
 *   2. the LOCAL SELF-CUSTODY WALLET (the root identity every install gets —
 *      src/values/signer.ts `ensureLocalWalletAddress`, surfaced at
 *      ~/.unbrowse/wallet.json). The wallet signature authenticates as
 *      `wallet:<pk>` on the backend — full principal, never key-gated.
 * A sync callback may publish the wallet identity to an account independently
 * of local API-key resolution (for example, when the callback owns its auth).
 *
 * `onboardingStatus` reports what's configured and the one next step to tell the user.
 * Every input (wallet peek, api-key resolver, sync) is injectable so this is testable
 * offline and embeddable in any frontend.
 */
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { ensureLocalWalletAddress } from "../values/signer.js";

function getSdkHome(): string {
  return process.env.UNBROWSE_HOME?.trim()
    || join(process.env.HOME?.trim() || homedir(), ".unbrowse");
}

export type IdentityKind = "account" | "wallet";

export interface Identity {
  kind: IdentityKind;
  /** masked api-key tail for an account, or the base58 wallet address. */
  id: string;
  /** true once the identity is reflected on the server-side account profile. */
  synced: boolean;
}

export interface OnboardOptions {
  /** Resolve a bound-account API key. Default: UNBROWSE_API_KEY from the environment. */
  resolveApiKey?: () => string | undefined;
  /** Peek the local self-custody wallet address (no creation). Default: ~/.unbrowse/wallet.json. */
  peekWallet?: () => string | undefined;
  /** Publish a local wallet identity onto an account (sync). Optional. */
  sync?: (id: Identity) => Promise<void>;
  /** Create the local wallet when absent. Injectable for hermetic runtimes/tests. */
  createWallet?: () => string | undefined | Promise<string | undefined>;
}

export interface OnboardingStatus {
  identity: Identity | null;
  hasAccount: boolean;
  hasWallet: boolean;
  /** One human-readable next step to surface during onboarding. */
  nextStep: string;
}

function defaultResolveApiKey(): string | undefined {
  const k = process.env.UNBROWSE_API_KEY?.trim();
  return k ? k : undefined;
}

function defaultPeekWallet(): string | undefined {
  try {
    const p = join(getSdkHome(), "wallet.json"); // same UNBROWSE_HOME/HOME contract as the CLI
    if (!existsSync(p)) return undefined;
    const j = JSON.parse(readFileSync(p, "utf8")) as { address?: unknown };
    return typeof j.address === "string" && j.address ? j.address : undefined;
  } catch {
    return undefined;
  }
}

function maskKey(key: string): string {
  return key.length <= 10 ? key : `${key.slice(0, 4)}…${key.slice(-4)}`;
}

/**
 * Ensure the agent has a usable identity. An explicitly configured account API
 * key wins; otherwise use (or lazily create) the local wallet.
 *
 * For SDK / agent usage this is **zero ceremony**: we lazily create the local
 * self-custody Ed25519 wallet if none exists. The caller never needs to run
 * the heavy `unbrowse setup` (browser + interactive prompts) just to use the
 * HTTP SDK surface.
 */
export async function ensureIdentity(opts: OnboardOptions = {}): Promise<Identity> {
  const apiKey = (opts.resolveApiKey ?? defaultResolveApiKey)();
  if (apiKey) {
    return { kind: "account", id: maskKey(apiKey), synced: true };
  }

  const wallet = (opts.peekWallet ?? defaultPeekWallet)();
  if (wallet) {
    const id: Identity = { kind: "wallet", id: wallet, synced: false };
    if (opts.sync) {
      await opts.sync(id);
      id.synced = true;
    }
    return id;
  }

  // SDK-first path: auto-create the local self-custody wallet so agents
  // never have to run the full CLI `unbrowse setup` just for identity.
  // We delegate to the canonical implementation in the main package when
  // available (it is safe, idempotent, and creates ~/.unbrowse/wallet.json).
  try {
    let addr: string | undefined;
    if (opts.createWallet) {
      addr = await opts.createWallet();
    } else {
      // This source is shared by the repo SDK and packaged SDK. Resolve the
      // canonical signer without baking in a path that only works in one tree.
      addr = ensureLocalWalletAddress();
    }
    if (addr) {
      const id: Identity = { kind: "wallet", id: addr, synced: false };
      if (opts.sync) {
        await opts.sync(id);
        id.synced = true;
      }
      return id;
    }
  } catch {
    // Fall through to the legacy error only if we truly cannot create one.
  }

  // Legacy fallback (deprecated web2 account key)
  throw new Error(
    "No identity yet. For SDK usage a local wallet is created automatically on first use. " +
      "If you see this, set UNBROWSE_API_KEY or ensure the wallet module can write ~/.unbrowse.",
  );
}

/** Report onboarding state + the single next step to show the user. */
export function onboardingStatus(opts: OnboardOptions = {}): OnboardingStatus {
  const apiKey = (opts.resolveApiKey ?? defaultResolveApiKey)();
  const wallet = (opts.peekWallet ?? defaultPeekWallet)();
  const hasAccount = !!apiKey;
  const hasWallet = !!wallet;

  let identity: Identity | null = null;
  let nextStep: string;
  if (hasWallet && hasAccount) {
    identity = { kind: "account", id: maskKey(apiKey as string), synced: true };
    nextStep = "You're set: the configured account key is active and the local wallet is available.";
  } else if (hasWallet) {
    identity = { kind: "wallet", id: wallet as string, synced: false };
    nextStep =
      "Local self-custody wallet ready (web3-native principal). Optionally bind an account " +
      "for payouts/sync: `unbrowse register --email you@example.com`.";
  } else if (hasAccount) {
    identity = { kind: "account", id: maskKey(apiKey as string), synced: true };
    nextStep = "Bound account-key only (deprecated web2 fallback). Run `unbrowse setup` to create a wallet.";
  } else {
    nextStep = "Run `unbrowse setup` to create your local wallet (the web3-native principal).";
  }
  return { identity, hasAccount, hasWallet, nextStep };
}
