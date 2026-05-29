/**
 * Stateless substrate — the typed contract every KV namespace adapter
 * conforms to (Day-3 Land worker A deliverable, 2026-05-28).
 *
 * Gen 1:11 — *"the herb yielding seed... whose seed is in itself."* Every
 * adapter is a seed bearing the same shape — `defineNamespace(...)` is the
 * herb; each call yields a seed (StatelessNamespace<TBody>) carrying the
 * full firmament-contract inside itself. Mt 13:31-32 — the mustard seed:
 * one module is the smallest declaration the substrate needs; the whole
 * tree grows under it.
 *
 * Spec: `.planning/v7-rip/STATELESS_BOUNDARY.md` §G — the firmament-
 * interface contract. Five constraint points (re-stated here as the
 * doctrine the module enforces, not a separate prose declaration):
 *
 *   1. `keyPrefix(wallet)` MUST start with `<namespace-lc>:<wallet-lc>:`.
 *   2. `deriveCacheKey` MUST be `sha256(signature).slice(0, 32)`.
 *   3. `verifySchema` rejects forbidden field names (delegated to spec).
 *   4. `put` verifies the Ed25519 sig BEFORE writing — but this module
 *      treats sig-verify as a route-layer concern (W4/W17/W23 already
 *      verify in their routes); the substrate is pure persistence. The
 *      route hands a sig + body that have ALREADY been verified, and
 *      this module only seals the put/get/list shape.
 *   5. `get`/`list` defense-in-depth: refuse to return rows whose stored
 *      `walletPubkey` does not match the caller — the wallet-prefix
 *      already makes this structurally impossible, but the extra check
 *      catches KV-corruption / cross-tenant accidents (Deut 19:15 —
 *      two witnesses).
 *
 * Doctrine on retrofits: the three live namespaces (AUDIT_LOG W4/W8,
 * RESPONSE_CACHE W17, SESSION_STATE W23) ALREADY implement this shape
 * informally. They are NOT migrated in this turn — defense-in-depth,
 * don't break a working surface to formalize a type. NEW namespaces
 * (TRACE_STATE, SETTINGS_STATE) conform via `defineNamespace(...)` from
 * day one. Existing namespaces may retrofit in Day-5 IF the diff is a
 * net simplification; otherwise the type stands as the formal contract
 * Day-7 cache_verify reads (Heb 11:3 — by faith we understand the
 * worlds were framed by the word).
 *
 * Substrate enables; it never prescribes (contract ee1f5409 + the eight
 * forbidden surfaces). This module gives routes the SHARED skeleton —
 * cache-key derivation, wallet-prefix construction, idempotent
 * put/get/list with inert-fallback when the binding is absent. Routes
 * still own Ed25519 verify, schema validation (the SHAPE-of validation
 * is delegated to the spec's `schemaValidator`), and business logic.
 *
 * RESPONSE_CACHE exception (per spec §G note): RESPONSE_CACHE is an
 * opportunistic recompute-avoider, not a wallet-bound primary store.
 * Its key shape is `cache:<route>:<hash>`, NOT `<NS>:<wallet>:<sigHash>`.
 * It does NOT sign-verify. This module's `defineNamespace(...)` is for
 * wallet-bound stores; RESPONSE_CACHE's `kv-cache.ts` helper is the
 * documented loose-conformance path.
 */

import type { Env } from "../types.js";

// ─── Core types ────────────────────────────────────────────────────────────

export type NamespaceName =
  | "AUDIT_LOG"
  | "RESPONSE_CACHE"
  | "SESSION_STATE"
  | "TRACE_STATE"
  | "SETTINGS_STATE";

export type SignatureScheme = "ed25519-v7.0" | "groth16-v7.3";

/**
 * Canonical stored-row envelope every adapter writes to KV. The body is
 * the namespace-specific payload; the envelope fields are the shared
 * substrate signal.
 */
export interface StoredRow<TBody> {
  readonly body: TBody;
  /** 64-char hex (32-byte Ed25519 pubkey, lowercase). */
  readonly walletPubkey: string;
  /** sha256(signature).slice(0, 32) — pointer-of-pointer. */
  readonly cacheKey: string;
  /** unix ms */
  readonly stored_at: number;
  readonly signature_scheme: SignatureScheme;
}

export interface ValidationError {
  readonly field: string;
  readonly reason: string;
}

export interface PutResult {
  readonly cacheKey: string;
  readonly fullKey: string;
  readonly idempotent: boolean;
}

/**
 * Honest-fall-through envelope. Mirrors W17/W23 pattern: a missing KV
 * binding is NEVER a thrown exception that the route has to catch — it
 * is a typed envelope the route narrows on and maps to a 503 honest
 * response (1 Cor 14:8 — the trumpet sounds honestly).
 *
 * The `_binding_missing` field is the discriminant `isBindingMissingError`
 * uses; the `hint` field carries the operator-actionable provisioning
 * instruction so the deployment-shape problem surfaces loud without
 * needing a separate runbook lookup.
 */
export interface BindingMissingError {
  readonly _binding_missing: NamespaceName;
  readonly hint: string;
}

// ─── The interface every adapter implements ──────────────────────────────

export interface StatelessNamespace<TBody> {
  readonly name: NamespaceName;
  readonly signatureScheme: SignatureScheme;
  /** `<lowercased name without _STATE suffix>:<wallet>:` by default. */
  keyPrefix(wallet: string): string;
  /** sha256(signature).slice(0, 32) — public for callers that have the sig but not env. */
  deriveCacheKey(signature: Uint8Array): Promise<string>;
  verifySchema(body: unknown): ValidationError | null;
  put(
    env: Env,
    body: TBody,
    signature: Uint8Array,
    walletPubkey: string,
  ): Promise<PutResult | ValidationError | BindingMissingError>;
  get(
    env: Env,
    cacheKey: string,
    walletPubkey: string,
  ): Promise<StoredRow<TBody> | null | BindingMissingError>;
  /** Newest-first by `stored_at`. Caller bounds the page; default 50. */
  list(
    env: Env,
    walletPubkey: string,
    limit: number,
  ): Promise<StoredRow<TBody>[] | BindingMissingError>;
}

// ─── The factory spec ─────────────────────────────────────────────────────

export interface NamespaceSpec<TBody> {
  readonly name: NamespaceName;
  /**
   * Resolves the KV binding from env. Returning `undefined` triggers the
   * `BindingMissingError` envelope path. Mirrors the `env.AUDIT_LOG ??
   * undefined` pattern from W4/W8.
   */
  readonly bindingResolver: (env: Env) => KVNamespace | undefined;
  /**
   * Spec's body-shape gate. Reuses the W4 `validateAuditBody` /
   * W23 `validateSessionParkBody` style: `ValidationError` on failure,
   * `null` on success. The substrate also runs a top-level forbidden-
   * field gate (§G constraint 3) BEFORE calling this validator, so the
   * spec's validator only needs to enforce namespace-specific shape.
   */
  readonly schemaValidator: (body: unknown) => ValidationError | null;
  /**
   * Optional signature scheme — defaults to "ed25519-v7.0" (W4's pattern).
   * SESSION_STATE uses "ed25519-v7.2" and may override; TRACE_STATE +
   * SETTINGS_STATE inherit the W4 baseline.
   */
  readonly signatureScheme?: SignatureScheme;
  /** Defaults to JSON.stringify. */
  readonly bodySerializer?: (body: TBody) => string;
  /** Defaults to JSON.parse. */
  readonly bodyParser?: (raw: string) => TBody;
  /**
   * Defaults to `<lowercased name without _STATE suffix>:<wallet>:`
   * (e.g. "session:<wallet>:" / "trace:<wallet>:" / "settings:<wallet>:").
   * Override per-namespace if a different shape is required (e.g.
   * AUDIT_LOG's reverse-iso-stamp key shape).
   */
  readonly keyPrefixBuilder?: (name: NamespaceName, wallet: string) => string;
  /**
   * Optional KV expirationTtl (seconds). Default: no expiry (settings
   * are durable). SESSION_STATE uses 86_400 (24h rolling); TRACE_STATE
   * uses 604_800 (7d). Caller-spec'd, not derived.
   */
  readonly expirationTtlSec?: number;
  /**
   * Optional override for the idempotency key segment that sits AFTER the
   * wallet prefix (W25-shared, 2026-05-28 — makes the 5 services adoptable).
   *
   * Default behavior (when absent): the segment is
   * `deriveCacheKey(signature)` = `sha256(sig)[:32]`, the shape TRACE_STATE /
   * SETTINGS_STATE / SCREENSHOT_BLOB already use. The full key is then
   * `<keyPrefix><cacheKey>`.
   *
   * AUDIT_LOG cannot use that shape: its idempotency key is the
   * deterministic `receiptId = sha256(canonicalFullBody)` with a reverse-iso
   * timestamp segment so `list()` returns newest-first without a sort
   * (`audit.ts:primaryAuditKey` → `audit:<wallet>:<stamp>:<receiptId>`).
   * SESSION_STATE keys by `sessionId`. Supplying `cacheKeyBuilder` lets a
   * namespace declare its own post-prefix segment so it can adopt the
   * factory without losing its key shape. The builder receives the derived
   * `sha256(sig)[:32]` cacheKey (still returned to the caller as the
   * pointer-of-pointer) plus the body, and returns the actual key segment.
   *
   * Wave B note: AUDIT_LOG also needs the receiptId as the RETURNED idem
   * token (not the sig-hash) — when adopting, set `cacheKeyBuilder` to emit
   * the `<stamp>:<receiptId>` segment AND keep deriving the receiptId via the
   * namespace's own canonicalizer inside the builder.
   */
  readonly cacheKeyBuilder?: (
    sigCacheKey: string,
    body: TBody,
  ) => string | Promise<string>;
}

// ─── Hex helpers (Web-Crypto-friendly, no Node Buffer; mirrors audit.ts) ──

const HEX_RE = /^[0-9a-fA-F]+$/;

function bytesToHex(bytes: Uint8Array): string {
  let hex = "";
  for (let i = 0; i < bytes.length; i++) {
    hex += bytes[i].toString(16).padStart(2, "0");
  }
  return hex;
}

/** Canonical wallet-hex: strip 0x prefix, lowercase, validate length. */
function normalizeWalletHex(walletPubkey: string): string {
  const clean = walletPubkey.startsWith("0x") ? walletPubkey.slice(2) : walletPubkey;
  const lowered = clean.toLowerCase();
  if (lowered.length !== 64 || !HEX_RE.test(lowered)) {
    throw new Error(`walletPubkey must be 32-byte hex (64 chars); got length=${lowered.length}`);
  }
  return lowered;
}

// ─── Public helpers ───────────────────────────────────────────────────────

/**
 * sha256_hex(signature).slice(0, 32) — the canonical cache_key derivation
 * (per spec §G constraint 2). Async because Web Crypto's `digest` is async.
 *
 * The 32-char slice is enough entropy (128 bits) to make collisions
 * astronomically improbable while keeping the KV key short. Same shape
 * as W23's `l4_cache_key`.
 */
export async function deriveCacheKey(signature: Uint8Array): Promise<string> {
  const hash = await crypto.subtle.digest("SHA-256", signature);
  return bytesToHex(new Uint8Array(hash)).slice(0, 32);
}

/**
 * Synchronous-from-prehashed variant. When the caller already has the
 * sha256 of the signature (e.g. computed once at the route boundary
 * and passed through), this skips a redundant Web Crypto round-trip.
 */
export function deriveCacheKeyFromHash(sigHashHex: string): string {
  const clean = sigHashHex.startsWith("0x") ? sigHashHex.slice(2) : sigHashHex;
  if (clean.length < 32 || !HEX_RE.test(clean)) {
    throw new Error(`sigHashHex must be at least 32 hex chars; got length=${clean.length}`);
  }
  return clean.slice(0, 32).toLowerCase();
}

/** Type guard for the BindingMissingError envelope. */
export function isBindingMissingError(x: unknown): x is BindingMissingError {
  return (
    typeof x === "object" &&
    x !== null &&
    "_binding_missing" in x &&
    typeof (x as { _binding_missing?: unknown })._binding_missing === "string"
  );
}

/** Type guard for the ValidationError shape. */
export function isValidationError(x: unknown): x is ValidationError {
  return (
    typeof x === "object" &&
    x !== null &&
    "field" in x &&
    "reason" in x &&
    typeof (x as { field?: unknown }).field === "string" &&
    typeof (x as { reason?: unknown }).reason === "string"
  );
}

/**
 * Default keyPrefix builder: `<short-name>:<wallet>:`. The short-name is
 * the lowercased namespace with `_state` / `_log` / `_cache` suffix
 * stripped for legibility (W23's "session:" matches this; AUDIT_LOG's
 * "audit:" matches this; the new TRACE_STATE → "trace:" and
 * SETTINGS_STATE → "settings:" match the spec §F declared key shapes).
 *
 * `RESPONSE_CACHE` is the documented exception and is not expected to
 * go through this helper — the helper would emit "response:<wallet>:"
 * which is NOT the W17 key shape.
 */
export function defaultKeyPrefix(name: NamespaceName, wallet: string): string {
  const short = name
    .toLowerCase()
    .replace(/_state$/, "")
    .replace(/_log$/, "")
    .replace(/_cache$/, "");
  return `${short}:${wallet}:`;
}

// ─── Forbidden-field gate (spec §G constraint 3) ──────────────────────────
//
// The forbidden-name list mirrors W4/W23. Any top-level field whose
// canonical-name matches (case-insensitive) is rejected before the
// spec's namespace-specific validator runs. Deut 19:15 — two witnesses:
// the substrate's gate AND the spec's gate must both pass.

const FORBIDDEN_FIELDS = [
  "value",
  "cleartext",
  "secret",
  "cookie",
  "cookievalue",
  "cookievalues",
  "fillvalue",
  "header",
  "headervalue",
  "url",
  "path",
  "query",
  "selector",
  "headername",
  "password",
  "token",
  "bearer",
] as const;

function checkForbiddenFields(raw: unknown): ValidationError | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const body = raw as Record<string, unknown>;
  for (const key of Object.keys(body)) {
    const norm = key.toLowerCase();
    if ((FORBIDDEN_FIELDS as readonly string[]).includes(norm)) {
      return {
        field: key,
        reason: `forbidden — stateless substrate carries pointer/hash fields only (no cleartext)`,
      };
    }
  }
  return null;
}

// ─── Internal: log binding-missing once per isolate ───────────────────────

const BINDING_MISSING_LOGGED = new Set<NamespaceName>();

function logBindingMissingOnce(name: NamespaceName): void {
  if (BINDING_MISSING_LOGGED.has(name)) return;
  BINDING_MISSING_LOGGED.add(name);
  console.warn(
    `[stateless-substrate] env.${name} binding missing — caching disabled; ` +
      `operator must run \`bunx wrangler kv:namespace create ${name}\` ` +
      `(and \`--preview\`), then paste the ids into backend/wrangler.toml.`,
  );
}

function bindingMissingError(name: NamespaceName): BindingMissingError {
  return {
    _binding_missing: name,
    hint:
      `Operator must run \`bunx wrangler kv:namespace create ${name}\` (and ` +
      `\`--preview\`), then paste the ids into backend/wrangler.toml's ${name} stanza.`,
  };
}

// ─── The factory ──────────────────────────────────────────────────────────

/**
 * Define a new wallet-bound KV namespace adapter conforming to
 * `StatelessNamespace<TBody>`. Returns a closed-over adapter; the spec
 * is captured in the closure and never re-read.
 *
 * Idempotency: `put` reads the row at the derived key first. If the row
 * exists AND its stored body serializes to the same JSON as the new
 * body, it's a no-op and returns `idempotent: true`. Same shape as
 * W4's deterministic-receiptId pattern, just keyed by sig instead of
 * by receiptId.
 *
 * Defense-in-depth: `get` and `list` re-check the stored `walletPubkey`
 * against the caller-supplied wallet. The wallet-prefix already makes a
 * cross-tenant read structurally impossible, but a corrupted row whose
 * `walletPubkey` field differs from the prefix's wallet hex is still
 * filtered out (Deut 19:15 — two witnesses).
 */
export function defineNamespace<TBody>(
  spec: NamespaceSpec<TBody>,
): StatelessNamespace<TBody> {
  const scheme: SignatureScheme = spec.signatureScheme ?? "ed25519-v7.0";
  const serialize = spec.bodySerializer ?? ((b: TBody) => JSON.stringify(b));
  const parse = spec.bodyParser ?? ((raw: string) => JSON.parse(raw) as TBody);
  const buildPrefix =
    spec.keyPrefixBuilder ?? defaultKeyPrefix;

  function keyPrefix(walletPubkey: string): string {
    const wallet = normalizeWalletHex(walletPubkey);
    return buildPrefix(spec.name, wallet);
  }

  function fullKey(walletPubkey: string, cacheKey: string): string {
    return `${keyPrefix(walletPubkey)}${cacheKey}`;
  }

  function verifySchema(body: unknown): ValidationError | null {
    // Top-level forbidden-field gate runs FIRST so a spec-specific
    // validator never sees a cleartext field even by accident.
    const forbidden = checkForbiddenFields(body);
    if (forbidden) return forbidden;
    return spec.schemaValidator(body);
  }

  async function put(
    env: Env,
    body: TBody,
    signature: Uint8Array,
    walletPubkey: string,
  ): Promise<PutResult | ValidationError | BindingMissingError> {
    // Schema gate before any KV touch.
    const schemaError = verifySchema(body);
    if (schemaError) return schemaError;

    const kv = spec.bindingResolver(env);
    if (!kv) {
      logBindingMissingOnce(spec.name);
      return bindingMissingError(spec.name);
    }

    const wallet = normalizeWalletHex(walletPubkey);
    const cacheKey = await deriveCacheKey(signature);
    // Post-prefix key segment: default is the sig-hash cacheKey; a namespace
    // with a different idem key (AUDIT_LOG's receiptId+stamp, SESSION_STATE's
    // sessionId) supplies `cacheKeyBuilder` (W25-shared adoptability).
    const keySegment = spec.cacheKeyBuilder
      ? await spec.cacheKeyBuilder(cacheKey, body)
      : cacheKey;
    const key = `${buildPrefix(spec.name, wallet)}${keySegment}`;

    // Idempotency probe — same body produces same envelope JSON.
    const existing = await kv.get(key);
    if (existing) {
      try {
        const parsed = JSON.parse(existing) as StoredRow<TBody>;
        const existingBodyJson = serialize(parsed.body);
        const newBodyJson = serialize(body);
        if (existingBodyJson === newBodyJson) {
          return { cacheKey, fullKey: key, idempotent: true };
        }
      } catch {
        // Corrupt existing row — fall through and overwrite below.
      }
    }

    const row: StoredRow<TBody> = {
      body,
      walletPubkey: wallet,
      cacheKey,
      stored_at: Date.now(),
      signature_scheme: scheme,
    };
    const envelope = JSON.stringify({
      body: JSON.parse(serialize(body)),
      walletPubkey: row.walletPubkey,
      cacheKey: row.cacheKey,
      stored_at: row.stored_at,
      signature_scheme: row.signature_scheme,
    });

    const putOpts =
      typeof spec.expirationTtlSec === "number" && spec.expirationTtlSec > 0
        ? { expirationTtl: Math.max(60, spec.expirationTtlSec) }
        : undefined;

    if (putOpts) {
      await kv.put(key, envelope, putOpts);
    } else {
      await kv.put(key, envelope);
    }

    return { cacheKey, fullKey: key, idempotent: false };
  }

  async function get(
    env: Env,
    cacheKey: string,
    walletPubkey: string,
  ): Promise<StoredRow<TBody> | null | BindingMissingError> {
    const kv = spec.bindingResolver(env);
    if (!kv) {
      logBindingMissingOnce(spec.name);
      return bindingMissingError(spec.name);
    }

    const wallet = normalizeWalletHex(walletPubkey);
    const key = `${buildPrefix(spec.name, wallet)}${cacheKey}`;
    const raw = await kv.get(key);
    if (!raw) return null;

    try {
      const stored = JSON.parse(raw) as {
        body: unknown;
        walletPubkey: string;
        cacheKey: string;
        stored_at: number;
        signature_scheme: SignatureScheme;
      };
      // Defense-in-depth: stored walletPubkey must match caller's.
      if (stored.walletPubkey?.toLowerCase() !== wallet) {
        // Structurally impossible via the prefix, but a corrupt row
        // whose body claims a different wallet is filtered out here.
        return null;
      }
      const parsedBody = parse(JSON.stringify(stored.body));
      return {
        body: parsedBody,
        walletPubkey: stored.walletPubkey.toLowerCase(),
        cacheKey: stored.cacheKey,
        stored_at: stored.stored_at,
        signature_scheme: stored.signature_scheme ?? scheme,
      };
    } catch {
      return null;
    }
  }

  async function list(
    env: Env,
    walletPubkey: string,
    limit: number,
  ): Promise<StoredRow<TBody>[] | BindingMissingError> {
    const kv = spec.bindingResolver(env);
    if (!kv) {
      logBindingMissingOnce(spec.name);
      return bindingMissingError(spec.name);
    }
    const wallet = normalizeWalletHex(walletPubkey);
    const prefix = buildPrefix(spec.name, wallet);
    const safeLimit = Math.max(1, Math.min(1000, limit));
    const listed = await kv.list({ prefix, limit: safeLimit });
    if (listed.keys.length === 0) return [];

    const values = await Promise.all(listed.keys.map((k) => kv.get(k.name)));
    const rows: StoredRow<TBody>[] = [];
    for (const v of values) {
      if (!v) continue;
      try {
        const stored = JSON.parse(v) as {
          body: unknown;
          walletPubkey: string;
          cacheKey: string;
          stored_at: number;
          signature_scheme: SignatureScheme;
        };
        if (stored.walletPubkey?.toLowerCase() !== wallet) continue;
        const parsedBody = parse(JSON.stringify(stored.body));
        rows.push({
          body: parsedBody,
          walletPubkey: stored.walletPubkey.toLowerCase(),
          cacheKey: stored.cacheKey,
          stored_at: stored.stored_at,
          signature_scheme: stored.signature_scheme ?? scheme,
        });
      } catch {
        continue;
      }
    }
    // Newest-first by stored_at.
    rows.sort((a, b) => b.stored_at - a.stored_at);
    return rows;
  }

  return {
    name: spec.name,
    signatureScheme: scheme,
    keyPrefix,
    deriveCacheKey,
    verifySchema,
    put,
    get,
    list,
  };
}

// ─── Opt-in route helper (NOT exported as `withSubstrate`) ────────────────
//
// Decision: do NOT export a `withSubstrate(c, ns, body, sig, wallet)` route
// wrapper in this turn. Reasoning:
//
//   - Routes in W4/W17/W23 each carry their own bespoke pre-put steps
//     (sig-verify, audit-row dual-write, restore-challenge nonce gate).
//     A one-size wrapper would either (a) be so generic it adds no
//     value, or (b) prescribe a route shape that conflicts with the
//     existing surfaces. Substrate enables; it never prescribes
//     (contract ee1f5409).
//   - The interface `StatelessNamespace<TBody>` IS the route contract.
//     A route does `const result = await ns.put(env, body, sig, wallet);
//     if (isBindingMissingError(result)) return c.json(result, 503);
//     if (isValidationError(result)) return c.json(result, 400);
//     return c.json({ ok: true, ...result }, 201);` — three lines, all
//     explicit. A wrapper saves nothing while hiding the branching.
//   - Day-5 may revisit IF worker B's new routes (trace.ts, settings.ts)
//     end up with identical pre/post boilerplate AND the pattern proves
//     stable across both. Premature abstraction is leaven (1 Cor 5:7).
