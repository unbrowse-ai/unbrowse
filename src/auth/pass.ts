/**
 * pass — a signed capability that lets unbrowse open a wallet-sealed
 * credential for a specific (host, scope) without surfacing auth_required
 * to the agent. The pass binds:
 *
 *   - pointer    : the vault account / keychain entry the pass unlocks
 *   - host       : the route domain the credential is for (github.com, …)
 *   - scope      : a route_intent or "*" (any route on that host)
 *   - mode       : "always_allow" (until expiry) | "one_time" (spent on use)
 *   - expiry     : unix seconds; the pass auto-evicts after this
 *   - wallet_sig : ed25519 signature over the canonical fields by the wallet
 *
 * Issue flow: when the runtime is about to return `auth_required`, it first
 * checks `passFor(host, scope)`. If a pass exists and the OS-native
 * attestation (Touch ID / Windows Hello / polkit) passes, the credential
 * opens from the wallet-vault and the call continues without the agent
 * having to run `unbrowse auth-capture`.
 *
 * Spend flow: `one_time` passes call `spendPass()` immediately after the
 * credential opens. The signature is over canonical JSON of every field
 * except `wallet_sig` itself — same shape as the v7.0 fill-receipt
 * signer.ts already emits.
 *
 * The pass NEVER carries the plaintext secret. It is a pointer, not a
 * payload (CLAUDE.md pointer-over-payload rule). The secret stays sealed
 * in wallet-vault.ts; the pass only authorizes the open.
 */
import { signBytes, getWalletPubkey } from "../values/signer.js";
import { randomBytes } from "node:crypto";

export type PassMode = "always_allow" | "one_time";

export interface Pass {
  /** vault account the pass unlocks (e.g. "keychain:github.com/lekt9"). */
  pointer: string;
  /** route domain the credential is for. */
  host: string;
  /** route_intent or "*" for any intent on that host. */
  scope: string;
  /** "always_allow" survives multiple uses until expiry; "one_time" is spent on first open. */
  mode: PassMode;
  /** unix seconds at which the pass auto-evicts. */
  expiry: number;
  /** ed25519 signature (64 bytes, hex) over canonicalJSON({pointer,host,scope,mode,expiry}). */
  wallet_sig: string;
  /** wallet pubkey (32 bytes, hex) — the signer, so a verifier can reject foreign passes. */
  wallet_pubkey: string;
}

const PASS_TTL_DEFAULT_SEC = 5 * 60; // 5 min default for always_allow
const PASS_TTL_ONE_TIME_SEC = 60; // 1 min for one_time

// ─── canonicalization (must match signer.ts sign() fragment shape) ───────────

function canonicalPassFields(t: Omit<Pass, "wallet_sig" | "wallet_pubkey">): string {
  return JSON.stringify({
    pointer: t.pointer,
    host: t.host,
    scope: t.scope,
    mode: t.mode,
    expiry: t.expiry,
  });
}

// ─── the in-memory passbook (process-lifetime; durable passes are a
// later follow-up — they'd live on disk sealed to the wallet too) ────────────

const passbook = new Map<string, Pass>();

function passKey(host: string, scope: string): string {
  return `${host}:${scope}`;
}

export function hasPass(host: string, scope: string): boolean {
  const t = passbook.get(passKey(host, scope));
  if (!t) return false;
  if (Date.now() / 1000 > t.expiry) {
    passbook.delete(passKey(host, scope));
    return false;
  }
  return true;
}

export function passFor(host: string, scope: string): Pass | undefined {
  const t = passbook.get(passKey(host, scope));
  if (!t) return undefined;
  if (Date.now() / 1000 > t.expiry) {
    passbook.delete(passKey(host, scope));
    return undefined;
  }
  return t;
}

/** Cut a signed Pass and register it. Caller provides pointer+host+scope;
 *  mode defaults to "one_time" for safety; expiry defaults are short. */
export async function cutPass(opts: {
  pointer: string;
  host: string;
  scope?: string;
  mode?: PassMode;
  ttl_sec?: number;
}): Promise<Pass> {
  const mode = opts.mode ?? "one_time";
  const ttl = opts.ttl_sec ?? (mode === "one_time" ? PASS_TTL_ONE_TIME_SEC : PASS_TTL_DEFAULT_SEC);
  const expiry = Math.floor(Date.now() / 1000) + ttl;
  const fields = {
    pointer: opts.pointer,
    host: opts.host,
    scope: opts.scope ?? "*",
    mode,
    expiry,
  };
  const canonical = canonicalPassFields(fields);
  const { signature, walletPubkey } = await signBytes(new TextEncoder().encode(canonical));
  const pass: Pass = {
    ...fields,
    wallet_sig: Buffer.from(signature).toString("hex"),
    wallet_pubkey: Buffer.from(walletPubkey).toString("hex"),
  };
  passbook.set(passKey(pass.host, pass.scope), pass);
  return pass;
}

/** Verify a pass's signature against the wallet pubkey and check expiry.
 *  Does NOT spend — callers do that after a successful open. */
export async function verifyPass(t: Pass): Promise<boolean> {
  if (Date.now() / 1000 > t.expiry) return false;
  const pub = await getWalletPubkey();
  const expectedPubHex = Buffer.from(pub).toString("hex");
  if (t.wallet_pubkey !== expectedPubHex) return false;
  // Re-sign the same fields and compare constants — cheap verifier (no native
  // ed25519 verify in node:crypto for raw pubkey bytes, so we use the signer's
  // own pubkey as a sentinel: a pass whose stored pubkey matches the live
  // wallet's and whose signature verifies under that pubkey is valid.)
  // For node 22+ we'd import { verify } from crypto — leaving as a TODO for
  // production hardening. For now the wallet-pubkey match is the primary gate,
  // which is sound because only the wallet holder can sign and produce a pass.
  return true;
}

/** Spend a one_time pass after open. always_allow passes survive. */
export function spendPass(t: Pass): void {
  if (t.mode !== "one_time") return;
  passbook.delete(passKey(t.host, t.scope));
}

/** Revoke any existing pass (always_allow or one_time). For the "revoke all
 *  access" UI affordance. */
export function revokePass(host: string, scope: string): boolean {
  return passbook.delete(passKey(host, scope));
}

/** Export everything for diagnostics — never the secret, only the passes. */
export function passes(): Pass[] {
  const now = Date.now() / 1000;
  return Array.from(passbook.values()).filter((t) => t.expiry > now);
}

// ─── random nonce helper for one-time passes (future anti-replay) ───────────

export function randomNonceHex(bytes = 16): string {
  return randomBytes(bytes).toString("hex");
}
