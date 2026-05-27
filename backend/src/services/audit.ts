/**
 * Audit-log service — v7.0 sig-shape, REAL KV storage (W8 wave, 2026-05-28).
 *
 * Scope: Ed25519 verification + canonical-JSON + receipt-id derivation +
 * REAL `env.AUDIT_LOG.put/get/list` storage path. Heb 4:13 — "all things
 * are naked and opened unto the eyes of him with whom we have to do": every
 * fill that crosses this surface is witnessed as a sealed receipt before
 * the Word, and the receipt is the witness (Deut 19:15 — two witnesses:
 * the deterministic receiptId AND the Ed25519 signature).
 *
 * Why scaffold-then-real: per .planning/v7-rip/ZK_SCOPE.md §"Phased
 * rollout: v7.0 (sig-shape) → v7.x (SNARK)", the entire pipeline runs
 * under exercise from day one with plain Ed25519. v7.3 swaps the same
 * wire field (`signature`) for a Groth16 proof — same body shape, no API
 * break. Both verify AND persistence paths are now REAL in v7.0.
 *
 * Operator provisioning (one-time, BEFORE deploying this wave to prod):
 *   bunx wrangler kv:namespace create AUDIT_LOG
 *   bunx wrangler kv:namespace create AUDIT_LOG --preview
 * Then paste the returned ids into `backend/wrangler.toml`'s AUDIT_LOG
 * stanza in place of the `TODO_create_via_wrangler_kv_namespace_create*`
 * placeholders. Deploy will continue to serve a 503-style honest empty
 * `{rows: [], _binding_missing: "AUDIT_LOG"}` if the binding is absent —
 * the route never silently swallows the missing-binding case.
 *
 * ─── KV namespace: AUDIT_LOG ───────────────────────────────────────────────
 *
 * Two key shapes, both content-addressed:
 *
 *   audit:<walletPubkey-hex>:<reverse-iso-timestamp>:<receiptId>
 *     → JSON blob of AuditFillBody + { received_at, verify_ok: boolean }
 *     Primary row, ordered newest-first (lexicographic descending) so
 *     `list({ prefix: "audit:<wallet>:" })` returns the most recent fills
 *     without a separate index. `reverse-iso-timestamp` =
 *     `(2 ** 53 - 1) - Date.now()` stringified, zero-padded to 16 chars.
 *
 *   audit:receipt:<receiptId>
 *     → "<walletPubkey-hex>:<reverse-iso-timestamp>"
 *     Pointer row for the verify-by-receipt-id endpoint. One row points
 *     into the primary key above; the verify endpoint resolves the
 *     pointer, reads the primary, and re-verifies the signature
 *     server-side. Pointer-not-payload, consistent with this repo's
 *     contract 3c2dd353.
 *
 * `receiptId` is deterministic: `hex(sha256(canonicalJSON(body)))`. The CLI
 * knows its own receipt id before the request lands, so the wire is
 * idempotent — a second POST with the same body is a no-op (caller sees
 * the same receipt id back).
 *
 * ─── Critical invariant ────────────────────────────────────────────────────
 *
 * The body MUST NOT contain cleartext values, cookies, URLs, selectors, or
 * header names. Hashes only. The `pointer` field IS allowed because it is
 * an addressable reference (op://Vault/Item/field), not a secret — see
 * VALUE_STORE_ADAPTERS.md §"Security invariants" #7. `validateAuditBody`
 * is the schema gate.
 *
 * The Ed25519 surface uses Web Crypto's native `Ed25519` algorithm, which
 * Cloudflare Workers expose since 2023 (same path as
 * `services/declare-signature.ts` and `lib/attestation.ts`). Node:crypto is
 * NOT used and `@noble/ed25519` is NOT added — Web Crypto is the
 * substrate-native choice; pulling either alternative would add a top-level
 * dep where none is needed (per W4 scope: "use built-ins where possible").
 */

import type { Env } from "../types.js";

// ─── Body shape (shared across all three POST variants) ────────────────────

export type AuditVariant = "fill" | "header-inject" | "payload-field";

/**
 * Signature scheme discriminator — forward-compat for the v7.3 SNARK swap.
 *
 * v7.0 ships `"ed25519-v7.0"`: 64-byte Ed25519 sig over the signed fragment
 * (length-gated to 128 hex chars in validateAuditBody).
 *
 * v7.3 will add `"groth16-v7.3"`: Groth16 proof bytes (~200 bytes; ~400 hex
 * chars). When that lands, validateAuditBody gains a scheme-aware branch on
 * the signature length gate; existing rows stay verifiable under the
 * ed25519-v7.0 branch. Without this discriminator a v7.3 client hitting a
 * v7.0-gate server would get a confusing "signature must be 128 chars"
 * error instead of an honest scheme-mismatch — see W4 scope gap.
 */
export type SignatureScheme = "ed25519-v7.0" | "groth16-v7.3";

/**
 * Per-scheme expected hex length of the `signature` field. Partial: schemes
 * that exist in the SignatureScheme union but don't yet have a pinned length
 * (e.g. groth16-v7.3 until the circuit is frozen) are absent from this map.
 * `validateAuditBody` rejects such schemes with an honest "no pinned length
 * yet" message instead of a misleading length-mismatch.
 */
const SIGNATURE_HEX_LENGTH: Partial<Record<SignatureScheme, number>> = {
  "ed25519-v7.0": 128, // 64 bytes
  // "groth16-v7.3": <pin once circuit is frozen>
} as const;

export interface AuditFillBody {
  // What was filled (pointer is an addressable reference, NEVER a value).
  pointer: string;
  // Per-fill 32-byte random nonce, base64-encoded. NEVER reused.
  nonce: string;
  // hex(sha256(url || ":" || selectorOrFieldName || ":" || timestamp_5min_bucket))
  // Binds the fill to a context so the same signature can't be replayed
  // against a different field.
  contextHash: string;
  // Value-commitment: hex(sha256(value || nonce)). Produced inside the
  // value-store adapter BEFORE the value bytes leave the disposal scope, so
  // the audit log can prove "the wallet held this value at fill-time" on
  // dispute (reveal value+nonce, re-hash, compare) without the value ever
  // touching the wire. 32-byte sha256 → 64 hex chars. NEVER the value.
  commitment: string;
  // Who authorized it.
  walletPubkey: string; // hex(Ed25519 pubkey, 32 bytes)
  // Signature scheme — fixes the wire shape for v7.3 SNARK forward-compat.
  // Defaults to "ed25519-v7.0" if the field is absent (v6→v7 upgrade window).
  signatureScheme?: SignatureScheme;
  // v7.0: Ed25519 signature over canonicalJSON({pointer, nonce, contextHash, commitment}).
  // v7.3: same field, swapped to a Groth16 proof — no API break.
  signature: string; // hex
  // Which endpoint variant produced this row.
  variant: AuditVariant;
  // Optional, variant-dependent forensic correlation. ALL HASHES; NO CLEARTEXT.
  urlHash?: string; // sha256(absolute URL)
  selectorHash?: string; // variant=fill: sha256(CSS selector)
  headerNameHash?: string; // variant=header-inject: sha256(header-name)
  payloadPath?: string; // variant=payload-field: JSON-path (no values)
}

export interface StoredAuditRow extends AuditFillBody {
  received_at: number; // unix ms
  verify_ok: boolean;
}

// ─── Hex / base64 helpers (Web-Crypto-friendly, no Node Buffer) ────────────

const HEX_RE = /^[0-9a-fA-F]+$/;
const BASE64_RE = /^[A-Za-z0-9+/]+={0,2}$/;

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

export function bytesToHex(bytes: Uint8Array): string {
  let hex = "";
  for (let i = 0; i < bytes.length; i++) {
    hex += bytes[i].toString(16).padStart(2, "0");
  }
  return hex;
}

// ─── Canonical JSON + receipt-id derivation ────────────────────────────────

/**
 * Canonical JSON over the SIGNED body fragment {pointer, nonce, contextHash}.
 * Key order is fixed so client and server agree on the exact bytes signed.
 * This is what the wallet's Ed25519 key signs in v7.0 and what the SNARK
 * predicate commits to in v7.3.
 */
export function canonicalizeSignedFragment(body: Pick<AuditFillBody, "pointer" | "nonce" | "contextHash" | "commitment">): string {
  return JSON.stringify({
    pointer: body.pointer,
    nonce: body.nonce,
    contextHash: body.contextHash,
    commitment: body.commitment,
  });
}

/**
 * Canonical JSON over the FULL body — the input to receiptId. Fixed key
 * order, every field present (optionals coerced to null if absent) so two
 * semantically-equal bodies produce the same hash.
 */
export function canonicalizeFullBody(body: AuditFillBody): string {
  return JSON.stringify({
    pointer: body.pointer,
    nonce: body.nonce,
    contextHash: body.contextHash,
    commitment: body.commitment,
    walletPubkey: body.walletPubkey,
    signatureScheme: body.signatureScheme ?? "ed25519-v7.0",
    signature: body.signature,
    variant: body.variant,
    urlHash: body.urlHash ?? null,
    selectorHash: body.selectorHash ?? null,
    headerNameHash: body.headerNameHash ?? null,
    payloadPath: body.payloadPath ?? null,
  });
}

/**
 * Deterministic receipt id — hex(sha256(canonicalJSON(body))). The CLI can
 * compute this itself before sending so the wire is idempotent: a second
 * POST with the same body returns the same receiptId, no duplicate row.
 */
export async function deriveReceiptId(body: AuditFillBody): Promise<string> {
  const canonical = canonicalizeFullBody(body);
  const bytes = new TextEncoder().encode(canonical);
  const hash = await crypto.subtle.digest("SHA-256", bytes);
  return bytesToHex(new Uint8Array(hash));
}

// ─── Schema validation ─────────────────────────────────────────────────────

export interface ValidationError {
  field: string;
  reason: string;
}

/**
 * Schema gate. Enforces the no-cleartext invariant by REQUIRING hash-shaped
 * fields for everything that could leak a value/URL/selector/header. Pointer
 * is the lone allowed addressable reference.
 *
 * Returns null on success, or a ValidationError describing the first failure.
 */
export function validateAuditBody(raw: unknown): ValidationError | null {
  if (!raw || typeof raw !== "object") {
    return { field: "$body", reason: "body must be a JSON object" };
  }
  const body = raw as Record<string, unknown>;

  // Required string fields.
  for (const field of ["pointer", "nonce", "contextHash", "commitment", "walletPubkey", "signature", "variant"]) {
    const v = body[field];
    if (typeof v !== "string" || v.length === 0) {
      return { field, reason: `required string field missing or empty` };
    }
  }

  // Signature scheme — optional, defaults to ed25519-v7.0. Validate up-front
  // so the signature-length gate below can branch on it.
  const rawScheme = body.signatureScheme;
  if (rawScheme !== undefined && rawScheme !== null) {
    if (typeof rawScheme !== "string") {
      return { field: "signatureScheme", reason: "must be a string when present" };
    }
    if (!(rawScheme in SIGNATURE_HEX_LENGTH)) {
      return { field: "signatureScheme", reason: `unsupported scheme '${rawScheme}'` };
    }
  }
  const scheme: SignatureScheme = (rawScheme as SignatureScheme | undefined) ?? "ed25519-v7.0";

  const variant = body.variant as string;
  if (variant !== "fill" && variant !== "header-inject" && variant !== "payload-field") {
    return { field: "variant", reason: "must be fill | header-inject | payload-field" };
  }

  // Wallet pubkey: 32-byte hex (64 chars, optional 0x prefix).
  const walletPubkey = body.walletPubkey as string;
  const walletClean = walletPubkey.startsWith("0x") ? walletPubkey.slice(2) : walletPubkey;
  if (walletClean.length !== 64 || !HEX_RE.test(walletClean)) {
    return { field: "walletPubkey", reason: "must be 32-byte hex (64 chars)" };
  }

  // Signature: scheme-aware hex length gate. ed25519-v7.0 = 128 chars; v7.3
  // groth16 will be ~400 chars (pinned once the circuit is frozen).
  const signature = body.signature as string;
  const sigClean = signature.startsWith("0x") ? signature.slice(2) : signature;
  const expectedLen = SIGNATURE_HEX_LENGTH[scheme];
  if (expectedLen === undefined) {
    return { field: "signatureScheme", reason: `scheme '${scheme}' has no pinned signature length yet` };
  }
  if (sigClean.length !== expectedLen || !HEX_RE.test(sigClean)) {
    return { field: "signature", reason: `must be ${expectedLen / 2}-byte ${scheme} hex (${expectedLen} chars)` };
  }

  // Nonce: base64-encoded 32 bytes (44 chars including padding).
  const nonce = body.nonce as string;
  if (!BASE64_RE.test(nonce) || nonce.length < 43 || nonce.length > 44) {
    return { field: "nonce", reason: "must be base64-encoded 32 bytes (43-44 chars)" };
  }

  // contextHash: 32-byte hex.
  const contextHash = body.contextHash as string;
  const ctxClean = contextHash.startsWith("0x") ? contextHash.slice(2) : contextHash;
  if (ctxClean.length !== 64 || !HEX_RE.test(ctxClean)) {
    return { field: "contextHash", reason: "must be sha256 hex (64 chars)" };
  }

  // commitment: 32-byte hex (sha256(value || nonce)). Produced inside the
  // value-store adapter; reveals nothing about value beyond fact-of-fill.
  const commitment = body.commitment as string;
  const commClean = commitment.startsWith("0x") ? commitment.slice(2) : commitment;
  if (commClean.length !== 64 || !HEX_RE.test(commClean)) {
    return { field: "commitment", reason: "must be sha256 hex (64 chars)" };
  }

  // Pointer: must look like <scheme>://<rest>. Schemes we know: op,
  // keychain, keychain-secure, bw, arg. Unknown schemes are accepted at
  // this layer (the value-store registry is the authority) but the URI
  // shape gate prevents cleartext from slipping through.
  const pointer = body.pointer as string;
  if (!/^[a-z][a-z0-9+\-.]*:\/\/.+/.test(pointer)) {
    return { field: "pointer", reason: "must be a URI like op://... or keychain://..." };
  }

  // Variant-specific optional hashes — when present, must be valid sha256
  // hex. When absent, we accept (forensic correlation is optional at this
  // generic gate; the variant-specific gate below tightens it per variant).
  for (const field of ["urlHash", "selectorHash", "headerNameHash"]) {
    const v = body[field];
    if (v === undefined || v === null) continue;
    if (typeof v !== "string") {
      return { field, reason: "must be a string when present" };
    }
    const clean = v.startsWith("0x") ? v.slice(2) : v;
    if (clean.length !== 64 || !HEX_RE.test(clean)) {
      return { field, reason: "must be sha256 hex (64 chars) when present" };
    }
  }

  // payloadPath: structural locator (JSON-path) — NO values. We don't hash
  // it because the structure itself carries no secret. But we DO gate
  // strictly: must look like a JSON-path (starts with `$.` or `$['...']`),
  // bounded length, and reject embedded values (`=`, `:`, raw quotes
  // outside JSON-path bracket-quote syntax).
  //
  // Deut 19:15 — two witnesses: the path shape gate AND the forbidden-char
  // gate. A `user=admin` slipping through here would be a cleartext leak
  // dressed as a "path"; rejected at both witnesses.
  if (body.payloadPath !== undefined && body.payloadPath !== null) {
    const pp = body.payloadPath;
    if (typeof pp !== "string" || pp.length === 0) {
      return { field: "payloadPath", reason: "must be a non-empty string when present" };
    }
    if (pp.length > 200) {
      return { field: "payloadPath", reason: "must be <= 200 chars (no embedded payloads)" };
    }
    if (!/^\$(\.|\[)/.test(pp)) {
      return { field: "payloadPath", reason: "must start with '$.' or \"$['...]\" (JSON-path)" };
    }
    // Forbid value-shaped chars. `=` is the smoking gun for `key=value`
    // smuggling; bare `:` is illegal in JSON-path (the only `:` allowed is
    // inside a JSON-path filter expression `[?(...)]`, which we also reject
    // here for v7.0 — the CLI only emits dot-paths, see execute.ts).
    if (/[=:]/.test(pp)) {
      return { field: "payloadPath", reason: "must not contain '=' or ':' (no embedded values)" };
    }
    // Quotes are only legal inside `['...']` bracket-segments. A double
    // quote anywhere, or a single quote outside `['...']`, is a smuggling
    // attempt. v7.0 conservative: reject any double-quote, allow single
    // quotes only when they pair around content inside `[...]`.
    if (/"/.test(pp)) {
      return { field: "payloadPath", reason: "must not contain '\"' (use $['key'] bracket form)" };
    }
  }

  // Forbidden fields — anti-stub gate. If any of these slip in, the caller
  // is leaking cleartext through the audit log. Reject loudly.
  const forbidden = ["value", "cleartext", "secret", "cookie", "header", "url", "selector", "headerName"];
  for (const field of forbidden) {
    if (field in body) {
      return { field, reason: `forbidden — audit log carries hashes only (no cleartext)` };
    }
  }

  // ─── Variant-specific required + mutually-exclusive correlation ────────
  //
  // Deut 19:15 — "at the mouth of two witnesses, or at the mouth of three
  // witnesses, shall the matter be established": each variant is a
  // distinct witness with its OWN required locator. A variant carrying
  // another variant's locator is a category error — reject so the
  // forensic trail stays unambiguous.
  //
  // fill:           requires selectorHash; rejects headerNameHash / payloadPath
  // header-inject:  requires headerNameHash; rejects selectorHash / payloadPath
  // payload-field:  requires payloadPath; rejects selectorHash / headerNameHash
  const variantRequirements: Record<AuditVariant, { required: string; forbidden: string[] }> = {
    "fill":          { required: "selectorHash",   forbidden: ["headerNameHash", "payloadPath"] },
    "header-inject": { required: "headerNameHash", forbidden: ["selectorHash", "payloadPath"] },
    "payload-field": { required: "payloadPath",    forbidden: ["selectorHash", "headerNameHash"] },
  };
  const req = variantRequirements[variant as AuditVariant];
  if (!body[req.required]) {
    return {
      field: req.required,
      reason: `missing_required_for_variant: variant='${variant}' requires '${req.required}'`,
    };
  }
  for (const f of req.forbidden) {
    if (body[f] !== undefined && body[f] !== null) {
      return {
        field: f,
        reason: `unexpected_field_for_variant: variant='${variant}' must not carry '${f}'`,
      };
    }
  }

  return null;
}

// ─── Ed25519 verification (REAL in v7.0; SNARK swaps in at v7.3) ───────────

/**
 * Verify the Ed25519 signature on the signed-fragment canonical JSON.
 * Returns true iff the wallet identified by `walletPubkey` produced the
 * `signature` over `canonicalizeSignedFragment(body)`.
 *
 * Catches every Web Crypto exception (malformed key/sig/length) and
 * returns false rather than throwing — the caller treats unverified as
 * "stored with verify_ok: false" so the audit trail records the attempt
 * even when the signature is bad (forensic value).
 */
export async function verifyAuditSignature(body: AuditFillBody): Promise<boolean> {
  try {
    const pubkeyBytes = hexToBytes(body.walletPubkey);
    if (pubkeyBytes.length !== 32) return false;
    const sigBytes = hexToBytes(body.signature);
    if (sigBytes.length !== 64) return false;
    const canonical = canonicalizeSignedFragment(body);
    const dataBytes = new TextEncoder().encode(canonical);
    const key = await crypto.subtle.importKey(
      "raw",
      pubkeyBytes,
      { name: "Ed25519" },
      false,
      ["verify"],
    );
    return await crypto.subtle.verify({ name: "Ed25519" }, key, sigBytes, dataBytes);
  } catch {
    return false;
  }
}

// ─── KV key derivation (used by both stub + real impl) ─────────────────────

const TIMESTAMP_BASE = Number.MAX_SAFE_INTEGER; // 2^53 - 1
const TIMESTAMP_PAD = 16;

/** Reverse-iso so lexicographic ascending list = chronological descending. */
export function reverseIsoStamp(nowMs: number = Date.now()): string {
  const reversed = TIMESTAMP_BASE - nowMs;
  return reversed.toString().padStart(TIMESTAMP_PAD, "0");
}

export function primaryAuditKey(walletPubkey: string, stamp: string, receiptId: string): string {
  // Normalize wallet pubkey to lowercase hex so listing is order-stable.
  const wallet = walletPubkey.toLowerCase().replace(/^0x/, "");
  return `audit:${wallet}:${stamp}:${receiptId}`;
}

export function pointerAuditKey(receiptId: string): string {
  return `audit:receipt:${receiptId}`;
}

// ─── KV storage paths — REAL impl (W8 wave, 2026-05-28) ────────────────────

/**
 * NotImplementedError — retained for backwards-compat with the route
 * handlers' existing catch-arms. With the W8 storage layer real, this is
 * only thrown by the in-progress v7.3 SNARK paths that aren't wired yet.
 * The route still maps it to a 501 so the wire surface stays honest.
 *
 * Hab 2:2 — "Write the vision, and make it plain": the error carries the
 * exact KV key the path WOULD touch, so a v7.x extension knows the
 * substrate slot.
 */
export class NotImplementedError extends Error {
  readonly code = "not_implemented_yet";
  constructor(
    readonly verb: "put" | "get" | "list",
    readonly kvKey: string,
    readonly waveHint: string,
  ) {
    super(`AUDIT_LOG.${verb}(${kvKey}) — ${waveHint}`);
    this.name = "NotImplementedError";
  }
}

/**
 * BindingMissingError — thrown when `env.AUDIT_LOG` is undefined. Distinct
 * from NotImplementedError: the impl IS wired, the operator just hasn't
 * provisioned the namespace yet (still running the `TODO_create_via_…`
 * placeholder in wrangler.toml). The route maps this to a 503 so the
 * deployment-shape problem is visible to ops without leaking config.
 *
 * 1 Cor 14:8 — "if the trumpet give an uncertain sound, who shall prepare
 * himself to the battle": a missing binding is NOT a silent empty list;
 * it surfaces honestly so the operator can run the kv:namespace create
 * commands.
 */
export class BindingMissingError extends Error {
  readonly code = "audit_log_binding_missing";
  constructor() {
    super(
      "env.AUDIT_LOG is undefined — operator must run `bunx wrangler kv:namespace create AUDIT_LOG` (and `--preview`), then paste the ids into backend/wrangler.toml.",
    );
    this.name = "BindingMissingError";
  }
}

function requireAuditLog(env: Env): KVNamespace {
  if (!env.AUDIT_LOG) throw new BindingMissingError();
  return env.AUDIT_LOG;
}

/**
 * Persist an audit row. REAL impl: writes both the primary row (full body
 * + verify_ok + received_at) and the pointer row (receiptId → primaryKey)
 * in parallel. Idempotent on receiptId: deterministic id means a second
 * POST with the same body is detected via the pointer-key probe and
 * returns the existing primaryKey unchanged. No second write.
 *
 * Why pointer-then-primary check order: if the pointer exists, the
 * primary MUST exist (Promise.all writes both or KV's eventual
 * consistency is the only window where they diverge — judged acceptable
 * because the verify path re-derives the signature from the primary, so
 * a missing primary surfaces as a 404 honestly rather than a corrupt-
 * pointer phantom row).
 *
 * Returns `{ receiptId, primaryKey, pointerKey, idempotent }` so the
 * route handler can echo `idempotent: true` to the caller.
 *
 * Heb 4:13 — every fill witnessed; the receipt is the witness; a second
 * fill on the same body is the SAME witness (Matt 18:19-20 — two or
 * three gathered in the same name).
 */
export async function persistAuditRow(
  env: Env,
  body: AuditFillBody,
  verifyOk: boolean,
  nowMs: number = Date.now(),
): Promise<{ receiptId: string; primaryKey: string; pointerKey: string; idempotent: boolean }> {
  const kv = requireAuditLog(env);
  const receiptId = await deriveReceiptId(body);
  const pointerKey = pointerAuditKey(receiptId);

  // Idempotency probe: if the pointer already exists, this body has
  // already been persisted (receiptId is deterministic over the canonical
  // body). Return the existing primaryKey without a second write.
  const existingPointer = await kv.get(pointerKey);
  if (existingPointer) {
    return {
      receiptId,
      primaryKey: existingPointer,
      pointerKey,
      idempotent: true,
    };
  }

  const stamp = reverseIsoStamp(nowMs);
  const primaryKey = primaryAuditKey(body.walletPubkey, stamp, receiptId);

  const storedRow: StoredAuditRow = {
    ...body,
    // Coerce signatureScheme to its v7.0 default so stored rows are
    // self-describing even when the wire omits the field.
    signatureScheme: body.signatureScheme ?? "ed25519-v7.0",
    received_at: nowMs,
    verify_ok: verifyOk,
  };
  const rowJson = JSON.stringify(storedRow);

  // Parallel write — KV is eventually consistent across the colo; we
  // accept that a sub-millisecond reader could see the pointer before
  // the primary (verify route would 404). Both writes either land or
  // both throw, so this is the closest to atomic KV offers.
  await Promise.all([
    kv.put(primaryKey, rowJson),
    kv.put(pointerKey, primaryKey),
  ]);

  return { receiptId, primaryKey, pointerKey, idempotent: false };
}

/**
 * List audit rows for one wallet, newest first. REAL impl: walks
 * `AUDIT_LOG.list({prefix: "audit:<wallet>:", limit})`, then `get`s each
 * primary row. Reverse-iso stamp in the key means ascending list IS
 * newest-first ordering — no in-memory sort needed.
 *
 * Per-row `get` is required (KV list returns key names, not values).
 * Parallel-fetch the values to keep latency bounded by the slowest get.
 */
export async function listAuditRowsByWallet(
  env: Env,
  walletPubkey: string,
  limit: number,
): Promise<StoredAuditRow[]> {
  const kv = requireAuditLog(env);
  const wallet = walletPubkey.toLowerCase().replace(/^0x/, "");
  const prefix = `audit:${wallet}:`;

  const listed = await kv.list({ prefix, limit });
  if (listed.keys.length === 0) return [];

  // Parallel-fetch values. Skip any row whose value is missing (a torn
  // write or a manually-deleted primary) — listed.keys is the source of
  // truth for "which rows exist", but we still re-verify by reading the
  // value (defense-in-depth against KV inconsistency).
  const values = await Promise.all(
    listed.keys.map((k) => kv.get(k.name)),
  );

  const rows: StoredAuditRow[] = [];
  for (const v of values) {
    if (!v) continue;
    try {
      const parsed = JSON.parse(v) as StoredAuditRow;
      rows.push(parsed);
    } catch {
      // Skip corrupt row — bench-time corruption is rare; surface as a
      // missing-row rather than poisoning the whole list.
      continue;
    }
  }
  return rows;
}

/**
 * Read one audit row by receiptId via the pointer-key indirection.
 * Pointer-not-payload (this repo's contract 3c2dd353): the pointer row
 * holds the primaryKey, the primary row holds the body. Returns null
 * when either the pointer or the primary is missing (404 at the route).
 *
 * The route handler MUST re-verify the Ed25519 signature on the returned
 * row — never trust the stored `verify_ok` bit alone, which would only
 * tell you "the signature was valid when we wrote it", not "the stored
 * bytes are still well-formed". The re-derive catches KV corruption.
 */
export async function readAuditRowByReceiptId(
  env: Env,
  receiptId: string,
): Promise<StoredAuditRow | null> {
  const kv = requireAuditLog(env);
  const pointerKey = pointerAuditKey(receiptId);
  const primaryKey = await kv.get(pointerKey);
  if (!primaryKey) return null;
  const rowJson = await kv.get(primaryKey);
  if (!rowJson) return null;
  try {
    return JSON.parse(rowJson) as StoredAuditRow;
  } catch {
    return null;
  }
}
