/**
 * Shared types for the v7 value-store layer.
 *
 * platform: .planning/v7-rip/VALUE_STORE_ADAPTERS.md
 *
 * Security invariants enforced by these types:
 *  - `ResolvedValue.value` is `Uint8Array`, never `string`. Forces the caller
 *    to consume bytes directly and prevents accidental V8 string interning of
 *    secret material (a `.toString()` on a Uint8Array yields "0,1,2,..." —
 *    not the cleartext — so the type system makes the wrong call useless).
 *  - `ResolvedValue` is `AsyncDisposable` (TS 5.2+ explicit-resource-mgmt).
 *    `await using resolved = await resolve(...)` zeroes on scope exit via
 *    `Symbol.asyncDispose`.
 *  - No accessor on `ResolvedValue` returns a `string`.
 */

/** Pointer scheme tag. v7.0 ships exactly four adapters. */
export type Scheme = "op" | "keychain" | "bw" | "arg";

/** A parsed pointer URI. */
export interface Pointer {
  readonly scheme: Scheme;
  /** Everything after `<scheme>://`. */
  readonly path: string;
  /** The original URI string, for audit + receipt body. */
  readonly raw: string;
}

/**
 * The output of `resolve()`. Owns the cleartext buffer for the duration of
 * its disposal scope. Caller MUST consume `value` inside the scope and let
 * the AsyncDisposable hook zero the buffer.
 */
export interface ResolvedValue extends AsyncDisposable {
  /**
   * Raw cleartext bytes. Never a string. Lifetime is bounded by the
   * AsyncDisposable scope — touching `.value` after disposal is UB.
   */
  readonly value: Uint8Array;

  /**
   * Ed25519 signature over `(pointer || nonce || contextHash)` made with the
   * x402-wallet-bound key. Safe to log. Lands in the route receipt body.
   *
   * In v7.0 this is a plain Ed25519 signature (see ZK_SCOPE §v7.0 sig-shape).
   * In v7.3 the SNARK swaps in behind the same surface; the field shape is
   * unchanged so downstream code (CDP fill primitive, receipt writer, audit
   * verifier) does not break on the upgrade.
   */
  readonly signature: Uint8Array;

  /** The wallet pubkey that produced `signature`. Safe to log. 32 bytes. */
  readonly walletPubkey: Uint8Array;

  /**
   * The fill-context-hash supplied by the caller in `AdapterContext`. Bound
   * into the signature so the receipt cannot be replayed against a different
   * (selector, url, session) tuple.
   */
  readonly contextHash: Uint8Array;

  /**
   * Value-commitment: `sha256(value || nonce)`. Lets the receipt prove "the
   * adapter HELD this value at fill-time" without ever carrying the value.
   * On dispute (or in a later-wave SNARK predicate), revealing (value, nonce)
   * is sufficient to re-verify against this commitment. Computed inside the
   * adapter BEFORE the value Uint8Array leaves the disposal scope, so the
   * receipt-writer (CDP fill primitive, audit POSTer) never touches cleartext.
   *
   * Safe to log; lands in the route receipt body + the audit-log POST.
   * 32 bytes.
   */
  readonly commitment: Uint8Array;

  /** Which adapter produced this value (for receipt + audit). */
  readonly adapter: Scheme;

  /** The pointer URI as originally requested. */
  readonly pointer: string;

  /** Best-effort zero of `value` on scope exit. */
  [Symbol.asyncDispose](): Promise<void>;
}

/**
 * Per-call context the caller MUST supply. The `argScope` is consulted by
 * the `arg://` adapter; other adapters ignore it. `contextHash` is bound to
 * the signature so the receipt is fill-site-specific.
 */
export interface AdapterContext {
  /** sha256(session_id || selector || url || timestamp_ms), 32 bytes. */
  readonly contextHash: Uint8Array;
  /** Tool-call arguments available to the `arg://` adapter. */
  readonly argScope?: Readonly<Record<string, unknown>>;
  /**
   * Optional per-call wall-clock budget for the adapter spawn. When unset,
   * the registry default (UNBROWSE_ADAPTER_TIMEOUT_MS or 5000) applies.
   */
  readonly timeoutMs?: number;
}

/**
 * A candidate value-POINTER surfaced by `enumerate()`. POINTER-ONLY: it
 * names *where* a value lives + metadata-derived labels, but NEVER the value
 * itself. This is the load-bearing invariant of the enumeration surface —
 * the candidate set must be rankable (by W31-A's route-side EBM) and
 * fillable (by W31-A's multi-slot populate) without ever dereferencing a
 * secret. The label/hint come from the store's non-secret metadata (item
 * title, account name), never from the cleartext.
 *
 * Mt 6:6 — the closet stays shut: enumerate lists the doors, not what's
 * behind them.
 */
export interface CandidatePointer {
  /** The pointer URI a later `resolve()` would dereference, e.g.
   * `op://Personal/Twitter/username`. Never carries a value. */
  readonly pointer: string;
  /** Human-/agent-readable label from store metadata (item title, account
   * name, arg key-name). NEVER the secret value. */
  readonly label: string;
  /** Which adapter scheme this candidate belongs to. */
  readonly scheme: Scheme;
  /** Optional extra non-secret hint (vault name, field name, item id). */
  readonly hint?: string;
}

/** Options passed to `enumerate()` to scope + rank the candidate set. */
export interface EnumerateOptions {
  /** Free-text intent ("login to twitter"); used for keyword ranking. */
  readonly intent?: string;
  /** The form-slot name ("username", "email", "password"). */
  readonly slotName?: string;
  /** The form-slot type hint ("text", "password", "email", ...). */
  readonly slotType?: string;
  /** Tool-call argScope, consulted by the `arg://` adapter only. */
  readonly argScope?: Readonly<Record<string, unknown>>;
  /** Per-call wall-clock budget for adapter spawns. */
  readonly timeoutMs?: number;
}

/** The single verb every adapter implements (plus an optional second one). */
export interface ValueAdapter {
  readonly scheme: Scheme;
  /** Lazy auth/unlock. Called once per process before first `resolve()`. */
  ensureReady(): Promise<void>;
  /** Dereference one pointer. See ResolvedValue lifecycle rules. */
  resolve(
    pointer: Pointer,
    nonce: Uint8Array,
    ctx: AdapterContext,
  ): Promise<ResolvedValue>;
  /**
   * OPTIONAL. List available candidate value-POINTERS for a slot. Adapters
   * that cannot (or should not) enumerate omit this method; the registry
   * treats them as contributing `[]`. enumerate() NEVER dereferences a
   * value — it returns pointers + non-secret metadata labels only.
   */
  enumerate?(opts: EnumerateOptions): Promise<CandidatePointer[]>;
}

/** Typed errors raised by the adapter layer. */
export type AdapterErrorCode =
  | "not_implemented_yet"
  | "invalid_pointer"
  | "unknown_scheme"
  | "adapter_locked"
  | "adapter_unavailable"
  | "adapter_timeout"
  | "adapter_spawn_failed"
  | "adapter_exit_nonzero"
  | "arg_missing"
  | "arg_path_invalid"
  | "platform_unsupported";

export class AdapterError extends Error {
  readonly code: AdapterErrorCode;
  readonly nextStep?: string;
  constructor(code: AdapterErrorCode, message: string, nextStep?: string) {
    super(message);
    this.name = "AdapterError";
    this.code = code;
    this.nextStep = nextStep;
  }
}
