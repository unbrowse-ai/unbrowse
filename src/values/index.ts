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
  type CandidatePointer,
  type EnumerateOptions,
  type ResolvedValue,
  type Scheme,
  type ValueAdapter,
} from "./types.js";

// re-export the trait surface
export {
  AdapterError,
  type AdapterContext,
  type AdapterErrorCode,
  type CandidatePointer,
  type EnumerateOptions,
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

/** Tokenize a free-text string into lowercase alphanum keyword tokens. */
function tokenize(s: string | undefined): string[] {
  if (!s) return [];
  return s
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((t) => t.length > 0);
}

/**
 * Keyword-overlap score between a candidate and the (intent, slotName) query
 * tokens. Counts how many query tokens appear as a substring of any candidate
 * token (label/pointer/hint). NO embedding — the EBM ranking is W31-A's
 * covenant-side job; this is just a cheap stable pre-filter sort key.
 */
function overlapScore(
  cand: CandidatePointer,
  queryTokens: readonly string[],
): number {
  if (queryTokens.length === 0) return 0;
  const candTokens = new Set([
    ...tokenize(cand.label),
    ...tokenize(cand.pointer),
    ...tokenize(cand.hint),
  ]);
  let score = 0;
  for (const q of queryTokens) {
    for (const c of candTokens) {
      if (c === q || c.includes(q) || q.includes(c)) {
        score += 1;
        break;
      }
    }
  }
  return score;
}

/**
 * Fan out to every registered adapter's optional `enumerate()`, merge the
 * candidate POINTER sets, and (when `intent`/`slotName` is given) sort by
 * simple keyword overlap so the most-relevant pointers float to the top.
 *
 * POINTER-ONLY: every returned `CandidatePointer` names where a value lives
 * plus non-secret metadata labels — NEVER a value. Adapters without
 * `enumerate()` (or that throw/are unavailable) contribute `[]` and never
 * abort the fan-out (a missing op binary must not kill arg enumeration).
 *
 * This is the candidate-set surface W31-A's multi-slot populate ranks over.
 */
export async function enumerateCandidates(
  opts: EnumerateOptions = {},
): Promise<CandidatePointer[]> {
  registerDefaults();
  const adapters = Array.from(REGISTRY.values());
  const settled = await Promise.allSettled(
    adapters.map(async (a: ValueAdapter): Promise<CandidatePointer[]> => {
      if (typeof a.enumerate !== "function") return [];
      try {
        const r = await a.enumerate(opts);
        return Array.isArray(r) ? r : [];
      } catch {
        // A failing adapter contributes nothing; it must not abort the merge.
        return [];
      }
    }),
  );

  const merged: CandidatePointer[] = [];
  const seen = new Set<string>();
  for (const s of settled) {
    if (s.status !== "fulfilled") continue;
    for (const cand of s.value) {
      if (!cand || typeof cand.pointer !== "string") continue;
      if (seen.has(cand.pointer)) continue;
      seen.add(cand.pointer);
      merged.push(cand);
    }
  }

  const queryTokens = [...tokenize(opts.intent), ...tokenize(opts.slotName)];
  if (queryTokens.length === 0) return merged;

  // Stable sort: higher overlap first; ties keep insertion (adapter fan-out)
  // order so the result is deterministic.
  return merged
    .map((cand, i) => ({ cand, i, score: overlapScore(cand, queryTokens) }))
    .sort((a, b) => (b.score - a.score) || (a.i - b.i))
    .map((x) => x.cand);
}
