/**
 * covenant-core.ts — the ONE shared substrate primitive module (W25-shared,
 * 2026-05-28).
 *
 * Eph 4:4 — *"There is one body, and one Spirit, even as ye are called in one
 * hope of your calling."* The 5 hand-rolled service files (`audit.ts`,
 * `session-state.ts`, `trace-state.ts`, `settings-state.ts`,
 * `screenshot-blob.ts`) each re-declare the SAME crypto/canonical/gate
 * primitives — 7× hex helpers, 7× Ed25519-verify, 6× BindingMissingError,
 * 6× deriveCacheKey, N× canonical-JSON, N× forbidden-field gates
 * (.planning/v7-rip/CONVERGENCE_MAP.md §5). This module is the one body those
 * limbs converge onto. Wave B rips the 5 redeclarations and imports here.
 *
 * ─── ADDITIVE-ONLY (this wave) ─────────────────────────────────────────────
 *
 * This module is NEW and additive. It does NOT yet edit the 5 service files
 * to import it — that is Wave B's rip (doing it now would race the byte-compat
 * verification this wave establishes). This wave's job: build the consolidated
 * primitives + PROVE byte-identity against the existing `audit.ts` reference
 * impl (the receipt-id MUST stay byte-compatible or Wave B breaks every
 * existing audit row's idempotency).
 *
 * ─── BYTE-COMPAT TARGET #1 — unbrowse audit.ts (load-bearing) ──────────────
 *
 * `deriveReceiptId(canonicalBody)` = `hex(sha256(canonicalBody))`. The
 * canonical body is produced by a per-namespace canonicalizer (different
 * services whitelist different fields — that part is legitimately
 * namespace-specific, see CONVERGENCE_MAP §5). What MUST stay shared and
 * byte-identical is the derive wrapper: take a `JSON.stringify`'d canonical
 * string → `crypto.subtle.digest("SHA-256", utf8(canonical))` → lowercase
 * hex. `audit.ts:270-275` does exactly this. The test
 * `backend/tests/v7-covenant-core.test.ts` proves
 * `deriveReceiptId(canonicalizeFullBody(body))` from this module byte-matches
 * `audit.ts.deriveReceiptId(body)` for the same AuditFillBody.
 *
 * ─── BYTE-COMPAT TARGET #2 — the covenant native binary ────────────────────
 *
 * Per .planning/v7-rip/COVENANT_SUBSTRATE_MAP.md §7 the covenant binary's
 * receipt pointer is:
 *     receipt = "sha256:" + sha256(JSON.stringify(covenant))
 * where `JSON.stringify` is INSERTION-ORDER (the field order produced by
 * `buildCovenant` — day, day_name, verb, trinity{...}, witness, ... — NOT
 * sorted-key canonicalization). Verified in the map: recomputing
 * `sha256(blob_file_contents)` for `blobs/000015db…` reproduces the filename
 * exactly.
 *
 * unbrowse uses the SAME technique — insertion-order `JSON.stringify` of an
 * explicit field list → `crypto.subtle SHA-256` → hex — it only diverges on
 * WHAT is hashed (covenant hashes the 9-field Covenant; unbrowse hashes a
 * flat body of pointers+hashes). So Wave B's peer-federation can produce
 * ledger-compatible receipt ids by:
 *   1. Using `canonicalize(obj, fieldOrder)` from this module to stringify in
 *      a fixed insertion order (NEVER `JSON.stringify` with sorted keys).
 *   2. Calling `deriveReceiptId(canonical)` for the bare-hex form, OR
 *      `deriveCovenantReceiptPtr(canonical)` for the `sha256:`-prefixed form
 *      the covenant blob store uses.
 * The two stores stay byte-mechanically aligned; only the agreed field-set +
 * order differs per kind (CONVERGENCE_MAP §7: "the work is agreeing on the
 * field set and order, not changing the algorithm").
 *
 * ─── No new deps ────────────────────────────────────────────────────────────
 *
 * Web Crypto only (`crypto.subtle`, `crypto.getRandomValues`, `atob`/`btoa`).
 * No `@noble/*`, no `node:crypto`, no Buffer — Workers-native, same choice the
 * 5 services already made.
 */

// ─── Hex helpers (the audit.ts reference versions — CONVERGENCE_MAP §5) ─────

const HEX_RE = /^[0-9a-fA-F]+$/;

/**
 * Decode a hex string (optional `0x` prefix) to bytes. Byte-identical to
 * `audit.ts:180-189` / `session-state.ts:75-84` / the other 5 copies.
 * Throws on odd length or non-hex chars (the reference behavior).
 */
export function hexToBytes(hex: string): Uint8Array {
  const clean = hex.startsWith("0x") ? hex.slice(2) : hex;
  if (clean.length % 2 !== 0) throw new Error("hex string must have even length");
  if (clean.length > 0 && !HEX_RE.test(clean)) throw new Error("hex string contains non-hex chars");
  const out = new Uint8Array(clean.length / 2);
  for (let i = 0; i < out.length; i++) {
    out[i] = parseInt(clean.substring(i * 2, i * 2 + 2), 16);
  }
  return out;
}

/**
 * Encode bytes as lowercase hex. Byte-identical to `audit.ts:191-197` and the
 * 6 other copies. Accepts `Uint8Array` (the reference signature); pass
 * `new Uint8Array(arrayBuffer)` for a digest result.
 */
export function bytesToHex(bytes: Uint8Array): string {
  let hex = "";
  for (let i = 0; i < bytes.length; i++) {
    hex += bytes[i].toString(16).padStart(2, "0");
  }
  return hex;
}

/**
 * Decode standard base64 (with or without `=` padding) to bytes. Uses Workers
 * `atob`. The 5 services don't decode base64 (they validate the shape and pass
 * it through), but the CLI `_stateless.ts` and the screenshot-blob route
 * decode it — Wave B converges those decoders here.
 */
export function base64ToBytes(b64: string): Uint8Array {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

/**
 * Encode bytes as standard base64 (with `=` padding). Uses Workers `btoa`.
 * Matches the `bytesToBase64` helper the tests + CLI hand-roll.
 */
export function bytesToBase64(bytes: Uint8Array): string {
  let s = "";
  for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
  return btoa(s);
}

// ─── Canonical JSON ─────────────────────────────────────────────────────────

/**
 * Canonical JSON via INSERTION-ORDER `JSON.stringify`. This is the byte-compat
 * heart of the substrate (CONVERGENCE_MAP §7, COVENANT_SUBSTRATE_MAP §7).
 *
 * Two call shapes:
 *
 *  - `canonicalize(obj)` — stringify the object in its own key-insertion
 *    order. Caller builds the object literal with fields in the exact order
 *    they must be hashed (this is what `audit.ts:canonicalizeFullBody`,
 *    `session-state.ts:canonicalizeSignedFragment`, etc. all do today: a
 *    literal `JSON.stringify({ a, b, c })`). Use this when the caller already
 *    controls field order via the literal.
 *
 *  - `canonicalize(obj, fieldOrder)` — project `obj` onto `fieldOrder` in the
 *    given sequence, coercing each absent field to `null` (matching the
 *    `?? null` convention `audit.ts:canonicalizeFullBody` uses for optionals),
 *    then stringify. Use this when the field order lives in a declared array
 *    rather than an object literal — the shape Wave B's `defineNamespace`
 *    canonicalizer-spec uses so a namespace declares its hashed-field order
 *    once.
 *
 * CRITICAL: this is NOT sorted-key canonicalization. Sorting keys would break
 * byte-compat with BOTH the covenant binary (insertion-order, §7) AND every
 * existing unbrowse audit row. Never reach for a sorted-key canonical-JSON lib
 * here.
 */
export function canonicalize(
  obj: Record<string, unknown>,
  fieldOrder?: readonly string[],
): string {
  if (!fieldOrder) return JSON.stringify(obj);
  const projected: Record<string, unknown> = {};
  for (const field of fieldOrder) {
    const v = obj[field];
    projected[field] = v === undefined ? null : v;
  }
  return JSON.stringify(projected);
}

// ─── Receipt-id / cache-key derivation ──────────────────────────────────────

/**
 * Deterministic receipt id = `hex(sha256(canonicalBody))`. Async (Web Crypto).
 *
 * BYTE-COMPAT with `audit.ts:270-275`: `audit.ts.deriveReceiptId(body)` does
 * `sha256(canonicalizeFullBody(body))` then `bytesToHex`. This function takes
 * the already-canonicalized string so the per-namespace field whitelist stays
 * in the namespace; the hash mechanism is shared. Proven byte-identical in
 * `v7-covenant-core.test.ts` test 3.
 *
 * Returns bare lowercase hex (no `sha256:` prefix). For the covenant blob
 * store's prefixed form use `deriveCovenantReceiptPtr`.
 */
export async function deriveReceiptId(canonicalBody: string): Promise<string> {
  const bytes = new TextEncoder().encode(canonicalBody);
  const hash = await crypto.subtle.digest("SHA-256", bytes);
  return bytesToHex(new Uint8Array(hash));
}

/**
 * The covenant binary's receipt POINTER form: `"sha256:" + hex(sha256(blob))`
 * (COVENANT_SUBSTRATE_MAP §7, `util.ts:107-118 putBlob`). Same hash as
 * `deriveReceiptId`, with the `sha256:` scheme prefix the covenant ledger keys
 * its blobs by. Wave B's peer-federation emits THIS form when registering an
 * unbrowse row as a covenant ledger blob so the pointer matches the binary's
 * filename convention.
 */
export async function deriveCovenantReceiptPtr(canonicalBody: string): Promise<string> {
  return `sha256:${await deriveReceiptId(canonicalBody)}`;
}

/**
 * Cache key = `sha256(signature)[:32]` (16 bytes → 32 hex chars). The
 * pointer-of-pointer KV idem key. Byte-identical to
 * `stateless-substrate.ts:215`, `trace-state.ts:158`, `settings-state.ts:120`,
 * `screenshot-blob.ts:152` (deriveSigKey). 128 bits of entropy — collisions
 * astronomically improbable, KV key stays short.
 */
export async function deriveCacheKey(signature: Uint8Array): Promise<string> {
  const hash = await crypto.subtle.digest("SHA-256", signature);
  return bytesToHex(new Uint8Array(hash)).slice(0, 32);
}

/** Hex-string convenience for `deriveCacheKey` — mirrors the `*Hex` wrappers. */
export async function deriveCacheKeyHex(signatureHex: string): Promise<string> {
  return deriveCacheKey(hexToBytes(signatureHex));
}

/**
 * `sha256(key)[:32]` over an arbitrary string key — the settings-state
 * `deriveSettingKeyHash` shape (`settings-state.ts:129-133`). Hashes a
 * user-named key so the KV key namespace stays non-enumerable.
 */
export async function deriveShortKeyHash(key: string): Promise<string> {
  const bytes = new TextEncoder().encode(key);
  const hash = await crypto.subtle.digest("SHA-256", bytes);
  return bytesToHex(new Uint8Array(hash)).slice(0, 32);
}

/** Full `sha256(bytes)` → 64-char hex. The screenshot-blob `sha256Hex` CAS helper. */
export async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const hash = await crypto.subtle.digest("SHA-256", bytes);
  return bytesToHex(new Uint8Array(hash));
}

// ─── Ed25519 verification ───────────────────────────────────────────────────

/**
 * Verify an Ed25519 signature. ONE copy replacing the 7 identical
 * `importKey({name:"Ed25519"}) → verify` blocks (CONVERGENCE_MAP §5). Takes
 * hex pubkey + hex sig + the raw message bytes (the canonical-fragment bytes
 * the caller already encoded). Returns false — never throws — on any malformed
 * input (wrong key/sig length, bad hex, Web Crypto rejection); the 5 services
 * all want "unverified" not "exception" so the row is still stored with
 * `verify_ok:false` for forensic value (`audit.ts:506-525`).
 */
export async function verifyEd25519(
  pubkeyHex: string,
  sigHex: string,
  message: Uint8Array,
): Promise<boolean> {
  try {
    const pubkeyBytes = hexToBytes(pubkeyHex);
    if (pubkeyBytes.length !== 32) return false;
    const sigBytes = hexToBytes(sigHex);
    if (sigBytes.length !== 64) return false;
    const key = await crypto.subtle.importKey(
      "raw",
      pubkeyBytes,
      { name: "Ed25519" },
      false,
      ["verify"],
    );
    return await crypto.subtle.verify({ name: "Ed25519" }, key, sigBytes, message);
  } catch {
    return false;
  }
}

/**
 * Verify a GET-challenge signature: Ed25519 over `<challenge>:<timestamp>`
 * (colon-delimited to defeat concat-ambiguity), with a max-age window.
 * Consolidates `session-state.ts:verifyRestoreChallenge` (sessionId:ts) and
 * `settings-state.ts:verifyReadChallenge` (keyHash:ts) — same shape, different
 * leading token. The caller passes whatever challenge token its namespace uses
 * (sessionId, keyHash, …); this function just verifies the colon-joined
 * message.
 *
 * `maxAgeMs` (default 0 = no age check) rejects timestamps older than the
 * window or in the future — the staleness guard the GET-challenge routes want
 * so a captured challenge sig can't be replayed indefinitely. Pass 0 to keep
 * the pure-verify behavior the two existing helpers have today (Wave B can
 * tighten the routes to pass a real window without changing this signature).
 */
export async function verifyWalletChallenge(
  challenge: string,
  sigHex: string,
  pubkeyHex: string,
  timestampMs: number,
  maxAgeMs = 0,
): Promise<boolean> {
  if (maxAgeMs > 0) {
    const age = Date.now() - timestampMs;
    if (!Number.isFinite(age) || age < -maxAgeMs || age > maxAgeMs) return false;
  }
  const message = new TextEncoder().encode(`${challenge}:${timestampMs}`);
  return verifyEd25519(pubkeyHex, sigHex, message);
}

// ─── Forbidden-field gate ───────────────────────────────────────────────────

export interface ValidationError {
  field: string;
  reason: string;
  code?: string;
}

/**
 * The union of all 5 services' forbidden-field lists — the shared no-cleartext
 * gate (CONVERGENCE_MAP §5). Wave B passes this default (or a namespace's own
 * superset) to `assertNoCleartext`. Lowercase-normalized; the gate matches
 * case-insensitively so `cookieValue`, `CookieValue`, `cookievalue` all trip.
 */
export const DEFAULT_FORBIDDEN_FIELDS: readonly string[] = [
  "value",
  "cleartext",
  "secret",
  "cookie",
  "header",
  "url",
  "selector",
  "headername",
  "password",
  "cleartext_value",
  "fillsecret",
  "plaintext",
  "raw_body",
  // additional union members the 5 services + stateless-substrate carry
  "cookievalue",
  "cookievalues",
  "fillvalue",
  "headervalue",
  "path",
  "query",
  "token",
  "bearer",
  "title",
] as const;

/**
 * No-cleartext gate. Rejects any top-level field whose lowercase name matches
 * the forbidden list. Returns a `ValidationError` on the first match, or
 * `null` when the body is clean. Consolidates the 7 `hasForbiddenField`
 * copies. Non-object / array / null bodies are treated as "no forbidden
 * top-level field" (caller's own shape gate rejects non-objects).
 */
export function assertNoCleartext(
  body: unknown,
  forbidden: readonly string[] = DEFAULT_FORBIDDEN_FIELDS,
): ValidationError | null {
  if (!body || typeof body !== "object" || Array.isArray(body)) return null;
  const lowered = new Set(forbidden.map((f) => f.toLowerCase()));
  for (const key of Object.keys(body as Record<string, unknown>)) {
    if (lowered.has(key.toLowerCase())) {
      return {
        field: key,
        reason: "forbidden — covenant substrate carries pointer/hash fields only (no cleartext)",
        code: "forbidden_cleartext_field",
      };
    }
  }
  return null;
}

// ─── BindingMissingError — ONE discriminated envelope ───────────────────────

/**
 * The canonical KV-namespace identifiers. Superset of
 * `stateless-substrate.ts:NamespaceName` plus `SCREENSHOT_BLOB` (the W-swarm
 * screenshot namespace that postdates the stateless-substrate type).
 */
export type CovenantNamespaceName =
  | "AUDIT_LOG"
  | "RESPONSE_CACHE"
  | "SESSION_STATE"
  | "TRACE_STATE"
  | "SETTINGS_STATE"
  | "SCREENSHOT_BLOB";

/**
 * The ONE binding-missing envelope, replacing the 6 redeclared
 * `BindingMissingError` classes (Day-8 Auditor-8). It is a plain typed
 * envelope, NOT a thrown `Error` — a missing KV binding is a deploy-shape
 * problem the route narrows on and maps to a 503 honest response (1 Cor 14:8 —
 * the trumpet sounds honestly), never an exception the route must catch.
 *
 * `_binding_missing` is the discriminant `isBindingMissingError` keys on;
 * `hint` carries the operator-actionable provisioning instruction so the
 * deploy-shape problem surfaces loud without a separate runbook lookup.
 */
export interface BindingMissingError {
  readonly _binding_missing: CovenantNamespaceName;
  readonly hint: string;
}

/** Build the canonical binding-missing envelope for a namespace. */
export function bindingMissingEnvelope(name: CovenantNamespaceName): BindingMissingError {
  return {
    _binding_missing: name,
    hint:
      `Operator must run \`bunx wrangler kv:namespace create ${name}\` (and ` +
      `\`--preview\`), then paste the ids into backend/wrangler.toml's ${name} stanza.`,
  };
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

/** Type guard for the ValidationError shape (re-exported for route narrowing). */
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

// ─── Wallet-prefixed KV key ─────────────────────────────────────────────────

/**
 * Build a wallet-prefixed KV key:
 *   `${prefix}:${walletHex-lowercase-no-0x}:${suffix}`.
 *
 * Consolidates the 5 services' `*PrimaryKey` / `*KeyPrefix` builders
 * (`audit.ts:primaryAuditKey`, `session-state.ts:sessionPrimaryKey`,
 * `trace-state.ts:tracePrimaryKey`, `settings-state.ts:settingsPrimaryKey`,
 * `screenshot-blob.ts:metaPrimaryKey`). The wallet-prefix IS the security
 * boundary — wallet-A's rows live under a different prefix than wallet-B's, so
 * cross-wallet enumeration is structurally impossible at the row-naming layer.
 *
 * Pass an empty `suffix` to build the list-prefix form (e.g.
 * `walletKey("session", w, "")` → `"session:<w>:"`).
 */
export function walletKey(prefix: string, walletHex: string, suffix: string): string {
  const wallet = walletHex.toLowerCase().replace(/^0x/, "");
  return `${prefix}:${wallet}:${suffix}`;
}
