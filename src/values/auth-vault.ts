/**
 * auth-vault — the wallet collects ALL auth & identity material, sealed to the key.
 *
 * Passwords, usernames, tokens, cookies, headers, API keys, OAuth secrets — every credential
 * an agent picks up is sealed to the holder's wallet (sealToWallet) and namespaced by
 * kind + name. Only the wallet-holder can reveal a value; a wrong wallet fails closed. The
 * durable copy is an opaque sealed blob — nothing is stored in the clear. This is the
 * identity half of the wallet: bind every secret to the private key.
 */
import { revealForWallet, sealToWallet, type WalletSealed } from "../trust/sealed-cache.js";

export type AuthKind =
  | "password"
  | "username"
  | "token"
  | "cookie"
  | "header"
  | "apikey"
  | "oauth"
  | "secret";

function scope(kind: AuthKind, name: string): string {
  return `auth:${kind}:${name}`;
}

export class AuthVault {
  private readonly entries = new Map<string, WalletSealed>();

  /** Seal an auth/identity value to the wallet and collect it under (kind, name). */
  async collect(kind: AuthKind, name: string, value: string, walletSecret: string): Promise<void> {
    const acct = scope(kind, name);
    this.entries.set(acct, await sealToWallet(value, walletSecret, acct));
  }

  /** Reveal a collected value for the holder; undefined for unknown OR a wrong wallet. */
  async reveal(kind: AuthKind, name: string, walletSecret: string): Promise<string | undefined> {
    const acct = scope(kind, name);
    const blob = this.entries.get(acct);
    if (!blob) return undefined;
    try {
      return (await revealForWallet(blob, walletSecret, acct)) as string;
    } catch {
      return undefined; // wrong wallet → fails closed
    }
  }

  has(kind: AuthKind, name: string): boolean {
    return this.entries.has(scope(kind, name));
  }

  /** The kinds of auth material collected (no values revealed). */
  kinds(): AuthKind[] {
    const set = new Set<AuthKind>();
    for (const key of this.entries.keys()) {
      const k = key.split(":")[1];
      if (k) set.add(k as AuthKind);
    }
    return [...set];
  }

  /** Content-addressed commitment for a collected entry (reveals nothing), or undefined. */
  commitmentOf(kind: AuthKind, name: string): string | undefined {
    return this.entries.get(scope(kind, name))?.commitment;
  }

  get size(): number {
    return this.entries.size;
  }
}
