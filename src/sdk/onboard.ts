/**
 * src/sdk/onboard.ts — identity onboarding for the agent.
 *
 * WEB3-NATIVE credential chain, resolved in order:
 *   1. the LOCAL SELF-CUSTODY WALLET (the root identity every install gets —
 *      src/values/signer.ts `ensureLocalWalletAddress`, surfaced at
 *      ~/.unbrowse/wallet.json). The wallet signature authenticates as
 *      `wallet:<pk>` on the backend — full principal, never key-gated.
 *   2. else a BOUND ACCOUNT — a deprecated web2 api-key wrapper (from a frontend
 *      OAuth login or `unbrowse register`), layered on top of the wallet to
 *      carry account-bound flows (payouts accrual, dashboard sync).
 *
 * `onboardingStatus` reports what's configured and the one next step to tell the user.
 * Every input (wallet peek, api-key resolver, sync) is injectable so this is testable
 * offline and embeddable in any frontend.
 */
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

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
    const p = join(process.env.HOME || homedir(), ".unbrowse", "wallet.json");
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
 * Ensure the agent has a usable identity, WALLET-FIRST. The wallet signature alone
 * is a full credential on the backend (`wallet:<pk>` principal). An account-key, if
 * present, is the optional web2 wrapper layered for payouts/sync continuity.
 * Throws only when neither a local wallet nor an account key can be found (run setup).
 */
export async function ensureIdentity(opts: OnboardOptions = {}): Promise<Identity> {
  const wallet = (opts.peekWallet ?? defaultPeekWallet)();
  if (wallet) {
    const id: Identity = { kind: "wallet", id: wallet, synced: false };
    const apiKey = (opts.resolveApiKey ?? defaultResolveApiKey)();
    if (apiKey && opts.sync) {
      await opts.sync(id);
      id.synced = true;
    }
    return id;
  }
  // No wallet: legacy fallback to a web2 account-key (deprecated — agents
  // without a wallet cannot sign the web3 auth challenge and will 401 on
  // wallet-sig-required routes once the wrapper is fully retired).
  const apiKey = (opts.resolveApiKey ?? defaultResolveApiKey)();
  if (apiKey) {
    return { kind: "account", id: maskKey(apiKey), synced: true };
  }
  throw new Error(
    "No identity yet. Run `unbrowse setup` to create a local self-custody wallet " +
      "(web3-native principal, preferred). Setting UNBROWSE_API_KEY (`unbrowse register`) " +
      "binds a deprecated web2 account wrapper over the wallet.",
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
    identity = { kind: "wallet", id: wallet as string, synced: true };
    nextStep = "You're set: wallet is your principal, account-key wraps payouts/sync.";
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
