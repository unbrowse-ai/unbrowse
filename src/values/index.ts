/**
 * v7 value-store public surface.
 *
 * One verb out the front door: `resolve(pointer, nonce, ctx)`. Picks the
 * adapter by scheme, ensures it is ready (cached promise), dereferences the
 * pointer, signs with the x402 wallet, and returns an AsyncDisposable
 * holding the cleartext for the caller's `await using` scope.
 *
 * Spec: .planning/v7-rip/VALUE_STORE_ADAPTERS.md
 * v7.0 signature surface: .planning/v7-rip/ZK_SCOPE.md §v7.0 (sig-shape)
 *
 * Adapter table is mutable via `registerAdapter()` so tests and host
 * integrations can inject mocks WITHOUT touching this module. v7.0 ships
 * with op / keychain / bw / arg pre-registered.
 */

import { ArgAdapter } from "./adapters/arg.js";
import { BwAdapter } from "./adapters/bw.js";
import { KeychainAdapter } from "./adapters/keychain.js";
import { OpAdapter } from "./adapters/op.js";
import { parse } from "./pointer.js";
import {
  AdapterError,
  type AdapterContext,
  type ResolvedValue,
  type Scheme,
  type ValueAdapter,
} from "./types.js";

// re-export the trait surface
export {
  AdapterError,
  type AdapterContext,
  type AdapterErrorCode,
  type Pointer,
  type ResolvedValue,
  type Scheme,
  type ValueAdapter,
} from "./types.js";
export { parse, looksLikePointer } from "./pointer.js";
export { safeZero, sodiumAvailable } from "./memzero.js";

const REGISTRY = new Map<Scheme, ValueAdapter>();

/** Idempotent. Called from `resolve()` on first use. Exposed for tests. */
export function registerDefaults(): void {
  if (REGISTRY.size > 0) return;
  REGISTRY.set("op", new OpAdapter());
  REGISTRY.set("keychain", new KeychainAdapter());
  REGISTRY.set("bw", new BwAdapter());
  REGISTRY.set("arg", new ArgAdapter());
}

/** Inject or override an adapter. Used by tests and the SDK shim. */
export function registerAdapter(adapter: ValueAdapter): void {
  REGISTRY.set(adapter.scheme, adapter);
}

/** Lookup an adapter by scheme. Throws on unknown. */
export function pick(scheme: Scheme): ValueAdapter {
  registerDefaults();
  const a = REGISTRY.get(scheme);
  if (!a) {
    throw new AdapterError(
      "unknown_scheme",
      `no adapter registered for scheme: ${scheme}`,
    );
  }
  return a;
}

/**
 * Dereference a pointer URI. Caller MUST consume the returned ResolvedValue
 * inside an `await using` scope so its AsyncDisposable hook can zero the
 * cleartext buffer within ~50 ms of use (the v7 budget).
 *
 *   await using v = await resolve("op://Personal/Twitter/username", nonce, ctx);
 *   // v.value is Uint8Array — pass it to the CDP fill primitive
 *   // v.signature, v.walletPubkey, v.contextHash land in the receipt body
 *
 * Stub body lives in `pick()`'s adapter resolve calls; this function itself
 * has a real signature so callers can type-check today.
 */
export async function resolve(
  pointer: string,
  nonce: Uint8Array,
  ctx: AdapterContext,
): Promise<ResolvedValue> {
  const parsed = parse(pointer);
  const adapter = pick(parsed.scheme);
  await adapter.ensureReady();
  return adapter.resolve(parsed, nonce, ctx);
}
