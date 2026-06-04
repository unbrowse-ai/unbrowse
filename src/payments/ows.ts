/**
 * src/payments/ows.ts — Open Wallet Standard (OWS v1.3) provider.
 *
 * OWS standardizes exactly what we hand-rolled: a local encrypted wallet vault
 * (~/.ows/wallets/<uuid>.json), policy-gated signing, and API-key delegated agent access,
 * with x402 payment built in (`ows pay request`). This module implements the OWS Core
 * Types (CAIP-2 / CAIP-10), the declarative policy engine, and vault resolution — so
 * unbrowse can use OWS as the primary wallet, an open standard alternative to lobster.cash
 * (the bespoke local signer in src/values/signer.ts becomes the legacy fallback).
 *
 * Pure + injectable: vault dir and clock come from env/args so it is testable offline.
 */
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

// ─── OWS Core Types (CAIP identifiers; spec §"Core Types") ──────────────────
export type ChainId = `${string}:${string}`; // CAIP-2, e.g. "eip155:1"
export type AccountId = `${ChainId}:${string}`; // CAIP-10
export type WalletId = string; // UUID v4

export interface AccountDescriptor {
  accountId: AccountId; // CAIP-10
  address: string; // chain-native
  derivationPath: string; // BIP-44
  chainId: ChainId; // CAIP-2
}

export interface WalletDescriptor {
  id: WalletId;
  name: string;
  createdAt: string; // ISO 8601
  chainType: string;
  accounts: AccountDescriptor[];
  metadata: Record<string, unknown>;
}

export interface ApiKey {
  id: string;
  name: string;
  tokenHash: string; // SHA-256 of raw token
  createdAt: string;
  walletIds: WalletId[];
  policyIds: string[];
  expiresAt?: string;
}

// ─── Policy (spec §"Policy" + CLI declarative rules) ────────────────────────
export type PolicyRule =
  | { type: "allowed_chains"; chain_ids: ChainId[] }
  | { type: "expires_at"; timestamp: string };

export interface OwsPolicy {
  id: string;
  name: string;
  version?: number;
  rules: PolicyRule[];
  action: "deny" | "warn";
}

export interface PolicyContext {
  chainId: ChainId;
  wallet: WalletDescriptor;
  timestamp: string; // ISO 8601 of the request
  apiKeyId?: string;
}

export interface PolicyResult {
  allow: boolean;
  reason?: string;
}

/**
 * Evaluate a declarative OWS policy against a request context. Rules are AND-combined —
 * every rule must pass or the request is denied (spec: "Rules are AND-combined"). `warn`
 * policies still report the failing reason but allow the action.
 */
export function evaluatePolicy(policy: OwsPolicy, ctx: PolicyContext): PolicyResult {
  let warnReason: string | undefined;
  for (const rule of policy.rules) {
    let failReason: string | undefined;
    if (rule.type === "allowed_chains") {
      if (!rule.chain_ids.includes(ctx.chainId)) failReason = `chain ${ctx.chainId} not in allowlist`;
    } else if (rule.type === "expires_at") {
      if (Date.parse(ctx.timestamp) >= Date.parse(rule.timestamp)) failReason = `policy expired at ${rule.timestamp}`;
    }
    if (failReason) {
      if (policy.action === "deny") return { allow: false, reason: failReason };
      warnReason ??= failReason; // warn: keep allowing, but surface the first violation
    }
  }
  return warnReason ? { allow: true, reason: warnReason } : { allow: true };
}

// ─── Vault resolution (spec §"File Layout": ~/.ows/wallets/<uuid>.json) ──────
export function owsHome(): string {
  return process.env.OWS_HOME || join(process.env.HOME || homedir(), ".ows");
}

function asString(v: unknown): string | undefined {
  return typeof v === "string" && v.trim() ? v.trim() : undefined;
}

// OWS wallet accounts come in two shapes: the spec's camelCase TS types and the
// `ows` CLI's snake_case JSON. Read either form defensively.
function accountChainId(a: unknown): string | undefined {
  const o = a as { chainId?: unknown; chain_id?: unknown } | null | undefined;
  return asString(o?.chainId) ?? asString(o?.chain_id);
}
function accountAddress(a: unknown): string | undefined {
  const o = a as { address?: unknown } | null | undefined;
  return asString(o?.address);
}

/** Read the public wallet descriptors from the OWS vault (no secret material). */
export function listOwsWallets(dir: string = join(owsHome(), "wallets")): WalletDescriptor[] {
  let files: string[];
  try {
    files = readdirSync(dir).filter((f) => f.endsWith(".json"));
  } catch {
    return [];
  }
  const out: WalletDescriptor[] = [];
  for (const f of files) {
    try {
      const d = JSON.parse(readFileSync(join(dir, f), "utf8")) as Partial<WalletDescriptor>;
      if (asString(d.id) && Array.isArray(d.accounts)) out.push(d as WalletDescriptor);
    } catch {
      // encrypted-only blob with no public descriptor → skip (resolve via the CLI instead)
    }
  }
  return out;
}

/**
 * The OWS wallet address to use as the agent's identity, preferring an explicit
 * OWS_WALLET_ADDRESS, else the first vault wallet's primary account (eip155 first, then any).
 * Returns undefined when OWS is not present — the caller falls back to the next provider.
 */
export function resolveOwsWalletAddress(opts?: { probeVault?: boolean }): string | undefined {
  const explicit = asString(process.env.OWS_WALLET_ADDRESS);
  if (explicit) return explicit;
  if (opts?.probeVault === false) return undefined;
  const wallets = listOwsWallets();
  for (const w of wallets) {
    const accounts = Array.isArray(w.accounts) ? w.accounts : [];
    // The `ows` CLI writes snake_case JSON (chain_id/account_id); the spec's TS types
    // are camelCase. Read both so a real OWS wallet actually resolves.
    const evm = accounts.find((a) => accountChainId(a)?.startsWith("eip155:"));
    const addr = accountAddress(evm) ?? accountAddress(accounts[0]);
    if (addr) return addr;
  }
  return undefined;
}

/** True when an OWS vault directory exists on this machine. */
export function owsAvailable(): boolean {
  return existsSync(owsHome());
}
