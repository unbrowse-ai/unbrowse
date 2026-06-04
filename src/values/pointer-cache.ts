/**
 * pointer-cache — high-speed KV cache whose entries stay valid only while their POINTER
 * dependencies are unchanged. The route-learning `cache` atom made reactive:
 *
 *   - content-addressed: a pointer holds a value whose sha256 is its address;
 *   - an entry pins the addresses of the pointers it was built against;
 *   - a read is O(1) (a Map hit) AND correct — HIT only if every dependency's CURRENT
 *     address equals the pinned one. When a pointer's VALUE changes, its address changes
 *     and every dependent goes stale and must recompute, while unrelated entries stay
 *     cached. This is docker's layer-hash invalidation, but pointer-reactive: fast, and
 *     updated the instant a dependency changes.
 *
 * Each entry is PUBLIC (value stored plain) or wallet-SEALED (value sealed via
 * sealToWallet — only the holder reveals), chosen per entry by whether auth is required.
 */
import { revealForWallet, sealToWallet, type WalletSealed } from "../trust/sealed-cache.js";

const UNSET = "∅:unset";

async function sha256Hex(s: string): Promise<string> {
  const h = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s));
  const b = new Uint8Array(h);
  let hex = "";
  for (let i = 0; i < b.length; i++) hex += b[i].toString(16).padStart(2, "0");
  return hex;
}

/** Content address of a value — same value ⇒ same address (docker-layer style). */
export async function pointerAddress(value: unknown): Promise<string> {
  return `sha256:${await sha256Hex(JSON.stringify(value ?? null))}`;
}

interface Entry {
  deps: Record<string, string>; // pointerId → address it was built against
  sealed: boolean;
  value?: unknown; // public
  blob?: WalletSealed; // sealed
}

export interface SetOptions {
  /** Pointer ids this entry depends on; changing any of their values stales the entry. */
  deps?: string[];
  /** Auth required → seal the value to the wallet (only the holder reveals). */
  auth?: boolean;
  /** Wallet secret used to seal, required when auth is true. */
  walletSecret?: string;
}

export interface GetResult {
  hit: boolean;
  value?: unknown;
  /** the entry is present but its dependencies changed → recompute. */
  stale?: boolean;
  /** the entry is present but wallet-sealed and you did not (correctly) unlock it. */
  sealed?: boolean;
}

export class PointerCache {
  private readonly pointers = new Map<string, string>(); // pointerId → current address
  private readonly entries = new Map<string, Entry>();
  private recomputes = 0;

  /** Set/update a pointer's value. Its address changes, staling every dependent. */
  async setPointer(pointerId: string, value: unknown): Promise<void> {
    this.pointers.set(pointerId, await pointerAddress(value));
  }

  /** Cache a value under `key`, pinning the current addresses of its pointer deps. */
  async set(key: string, value: unknown, opts: SetOptions = {}): Promise<void> {
    const deps: Record<string, string> = {};
    for (const p of opts.deps ?? []) deps[p] = this.pointers.get(p) ?? UNSET;

    if (opts.auth) {
      if (!opts.walletSecret) throw new Error("pointer-cache: an auth-required entry needs a walletSecret to seal");
      const blob = await sealToWallet(JSON.stringify(value ?? null), opts.walletSecret, key);
      this.entries.set(key, { deps, sealed: true, blob });
    } else {
      this.entries.set(key, { deps, sealed: false, value });
    }
  }

  /** Fresh ⇔ every dependency's current address equals the pinned one. */
  private fresh(e: Entry): boolean {
    for (const [p, addr] of Object.entries(e.deps)) {
      if ((this.pointers.get(p) ?? UNSET) !== addr) return false;
    }
    return true;
  }

  /**
   * Read. HIT only when present AND fresh. A stale entry (a dependency changed) is a MISS
   * that signals recompute. A sealed entry needs the right wallet secret to reveal.
   */
  async get(key: string, walletSecret?: string): Promise<GetResult> {
    const e = this.entries.get(key);
    if (!e) return { hit: false };
    if (!this.fresh(e)) {
      this.recomputes++;
      return { hit: false, stale: true };
    }
    if (e.sealed) {
      if (!walletSecret) return { hit: false, sealed: true }; // present but locked
      try {
        const plain = (await revealForWallet(e.blob as WalletSealed, walletSecret, key)) as string;
        return { hit: true, sealed: true, value: JSON.parse(plain) };
      } catch {
        return { hit: false, sealed: true }; // wrong wallet → fails closed
      }
    }
    return { hit: true, value: e.value };
  }

  has(key: string): boolean {
    return this.entries.has(key);
  }

  /** How many reads missed because a pointer dependency had changed (recompute count). */
  get recomputeCount(): number {
    return this.recomputes;
  }
}
