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
import {
  // W26-A: shared substrate primitives (Eph 4:4 — one body). The local
  // hex/canonical/Ed25519/forbidden-field copies are deleted and routed
  // through covenant-core; byte-compat preserved because covenant-core's
  // primitives ARE the audit.ts reference impl (W25-shared proved
  // deriveReceiptId byte-identical).
  hexToBytes,
  bytesToHex,
  canonicalize,
  deriveReceiptId as deriveReceiptIdFromCanonical,
  verifyEd25519,
  assertNoCleartext,
  walletKey,
} from "./covenant-core.js";

// ─── Body shape (shared across all three POST variants) ────────────────────

export type AuditVariant = "fill" | "header-inject" | "payload-field" | "breath-act";

/**
 * Discriminator for `breath-act` rows — the non-value-bearing breath
 * handlers (click, press, scroll, submit, type-literal, select-literal).
 * Day-6 Dominion worker 1 (2026-05-28) — A2 every act produces a sig-keyed
 * KV row, even when no value is filled. Gen 1:26 — "let them have
 * dominion": each act is witnessed at the firmament.
 *
 * The set is closed (string-literal union) so the schema gate rejects
 * unknown actTypes — a typo can't quietly create a phantom forensic
 * category. Adding a new breath handler means extending this union AND
 * the matching `breath-act` arm in validateAuditBody (one place to fail
 * loudly if either side drifts).
 */
export type BreathActType =
  | "click"
  | "press"
  | "scroll"
  | "submit"
  | "type-literal"
  | "select-literal"
  // Day-6 W24.2 extension — A2 coverage closure for the 5 remaining
  // breath handlers + 3 build handlers that previously emitted NO
  // sig-keyed row. Each new value is the act-name the handler ships.
  // Selector is OPTIONAL for all new entries (most carry no DOM target).
  | "navigate"
  | "teardown"
  | "auth-capture-start"
  | "auth-capture-finish"
  | "proxy-rotate"
  | "session-restore"
  | "build-skill"
  | "build-template"
  | "build-value-source";

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
  selectorHash?: string; // variant=fill OR breath-act: sha256(CSS selector). breath-act allows empty/absent for no-selector acts (e.g. focus-press).
  headerNameHash?: string; // variant=header-inject: sha256(header-name)
  payloadPath?: string; // variant=payload-field: JSON-path (no values)
  // variant=breath-act: which non-value act was performed. Closed enum
  // (BreathActType) — schema gate rejects unknown actTypes so typos can't
  // quietly create phantom forensic categories. NEVER carries selector
  // text or any value.
  actType?: BreathActType;
}

export interface StoredAuditRow extends AuditFillBody {
  received_at: number; // unix ms
  verify_ok: boolean;
}

// ─── Hex / regex helpers ───────────────────────────────────────────────────
//
// W26-A: hexToBytes/bytesToHex deleted — imported from covenant-core (Eph
// 4:4). Re-exported so the audit.ts public surface is unchanged for any
// downstream caller that imported them from here. HEX_RE / BASE64_RE stay
// local — they're the schema-gate's character-class checks, not crypto
// primitives (covenant-core gates length+hash, not wire-shape).
export { hexToBytes, bytesToHex };

const HEX_RE = /^[0-9a-fA-F]+$/;
const BASE64_RE = /^[A-Za-z0-9+/]+={0,2}$/;

// ─── Canonical JSON + receipt-id derivation ────────────────────────────────

/**
 * AUDIT_LOG field order — the exact insertion order of the full-body
 * canonical JSON (byte-compat with the pre-rip `canonicalizeFullBody`
 * literal). `canonicalize(obj, AUDIT_FIELD_ORDER)` projects onto this order
 * with absent optionals coerced to null, identical to the old `?? null`
 * literal. The field SET stays audit-specific; the field-order PROJECTION is
 * shared via covenant-core.canonicalize.
 */
const AUDIT_FIELD_ORDER = [
  "pointer",
  "nonce",
  "contextHash",
  "commitment",
  "walletPubkey",
  "signatureScheme",
  "signature",
  "variant",
  "urlHash",
  "selectorHash",
  "headerNameHash",
  "payloadPath",
  "actType",
] as const;

/**
 * Canonical JSON over the SIGNED body fragment {pointer, nonce, contextHash}.
 * Key order is fixed so client and server agree on the exact bytes signed.
 * This is what the wallet's Ed25519 key signs in v7.0 and what the SNARK
 * predicate commits to in v7.3.
 */
const AUDIT_SIGNED_FRAGMENT_ORDER = [
  "pointer",
  "nonce",
  "contextHash",
  "commitment",
] as const;

export function canonicalizeSignedFragment(body: Pick<AuditFillBody, "pointer" | "nonce" | "contextHash" | "commitment">): string {
  // W26-A: order-projection shared via covenant-core.canonicalize. All four
  // fields are required (never absent) so no null-coercion divergence; bytes
  // are byte-identical to the old literal.
  return canonicalize(body as Record<string, unknown>, AUDIT_SIGNED_FRAGMENT_ORDER);
}

/**
 * Canonical JSON over the FULL body — the input to receiptId. Fixed key
 * order, every field present (optionals coerced to null if absent) so two
 * semantically-equal bodies produce the same hash.
 */
export function canonicalizeFullBody(body: AuditFillBody): string {
  // W26-A: field-order PROJECTION routed through covenant-core.canonicalize
  // (shared insertion-order stringify); the audit-specific field SET +
  // signatureScheme default stay local. covenant-core coerces absent
  // optionals to null — identical to the old `?? null` literal — so the
  // emitted bytes are byte-for-byte the same. The scheme default
  // ("ed25519-v7.0") is applied BEFORE projection so it survives the
  // undefined→null coercion.
  return canonicalize(
    {
      pointer: body.pointer,
      nonce: body.nonce,
      contextHash: body.contextHash,
      commitment: body.commitment,
      walletPubkey: body.walletPubkey,
      signatureScheme: body.signatureScheme ?? "ed25519-v7.0",
      signature: body.signature,
      variant: body.variant,
      urlHash: body.urlHash,
      selectorHash: body.selectorHash,
      headerNameHash: body.headerNameHash,
      payloadPath: body.payloadPath,
      actType: body.actType,
    },
    AUDIT_FIELD_ORDER,
  );
}

/**
 * Set of allowed BreathActType values — string set so we can fast-check
 * in validateAuditBody. Mirrors the BreathActType union; if either drifts
 * the unit test `validateAuditBody rejects unknown actType` catches it.
 */
const BREATH_ACT_TYPES: ReadonlySet<string> = new Set([
  "click",
  "press",
  "scroll",
  "submit",
  "type-literal",
  "select-literal",
  // W24.2 — breath go/close/auth-capture/proxy-rotate/session-restore +
  // build skill/template/value-source. Keep ordered to match the union
  // above so a drift in either side trips the validateAuditBody test.
  "navigate",
  "teardown",
  "auth-capture-start",
  "auth-capture-finish",
  "proxy-rotate",
  "session-restore",
  "build-skill",
  "build-template",
  "build-value-source",
]);

/**
 * Deterministic receipt id — hex(sha256(canonicalJSON(body))). The CLI can
 * compute this itself before sending so the wire is idempotent: a second
 * POST with the same body returns the same receiptId, no duplicate row.
 */
export async function deriveReceiptId(body: AuditFillBody): Promise<string> {
  // W26-A: hash mechanism delegated to covenant-core.deriveReceiptId (the
  // SAME sha256→hex it always was; W25-shared proved byte-identity). The
  // audit-specific canonicalizer still produces the canonical input string,
  // so the derived id is unchanged for every existing audit row.
  return deriveReceiptIdFromCanonical(canonicalizeFullBody(body));
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
  if (
    variant !== "fill" &&
    variant !== "header-inject" &&
    variant !== "payload-field" &&
    variant !== "breath-act"
  ) {
    return { field: "variant", reason: "must be fill | header-inject | payload-field | breath-act" };
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

  // Forbidden fields — anti-stub gate, delegated to covenant-core's shared
  // assertNoCleartext (W26-A, Eph 4:4). The audit-local forbidden list was a
  // subset of DEFAULT_FORBIDDEN_FIELDS, so widening to the shared union is a
  // tightening (more cleartext-shaped fields rejected), never a loosening —
  // no previously-valid body is now rejected because none of those fields are
  // legal in an AuditFillBody. The shared gate matches case-insensitively
  // (the old `field in body` was case-sensitive), so `CookieValue` etc. now
  // also trip — strictly safer.
  const cleartext = assertNoCleartext(body);
  if (cleartext) return { field: cleartext.field, reason: cleartext.reason };

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
    "fill":          { required: "selectorHash",   forbidden: ["headerNameHash", "payloadPath", "actType"] },
    "header-inject": { required: "headerNameHash", forbidden: ["selectorHash", "payloadPath", "actType"] },
    "payload-field": { required: "payloadPath",    forbidden: ["selectorHash", "headerNameHash", "actType"] },
    // breath-act (Day-6 Dominion): non-value-bearing acts — click, press,
    // scroll, submit, type-literal, select-literal. Required locator is
    // `actType` (which act); selectorHash is OPTIONAL (focus-bound acts
    // like keyboard press have no selector). Mutually-exclusive with
    // headerNameHash/payloadPath (those are network-level witnesses, not
    // user-input gestures).
    "breath-act":    { required: "actType",        forbidden: ["headerNameHash", "payloadPath"] },
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

  // breath-act: actType must be a known string from the closed enum.
  // A typo here would create a phantom forensic category (a row with
  // actType='clikc' would never be queryable by the legitimate query).
  // Deut 19:15 — the actType IS the second witness alongside the
  // selectorHash; reject if it isn't a real witness.
  if (variant === "breath-act") {
    const actType = body.actType;
    if (typeof actType !== "string" || !BREATH_ACT_TYPES.has(actType)) {
      return {
        field: "actType",
        reason: `must be one of ${Array.from(BREATH_ACT_TYPES).join("|")} (got '${String(actType)}')`,
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
  // W26-A: Ed25519 import+verify delegated to covenant-core.verifyEd25519
  // (the ONE copy replacing all 7). It applies the same 32-byte-key /
  // 64-byte-sig length gates and the same catch-returns-false behavior, so
  // a malformed key/sig still yields verify_ok:false (forensic value), never
  // an exception. The audit-specific signed-fragment construction stays here.
  const canonical = canonicalizeSignedFragment(body);
  const dataBytes = new TextEncoder().encode(canonical);
  return verifyEd25519(body.walletPubkey, body.signature, dataBytes);
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
  // W26-A: wallet-prefix construction delegated to covenant-core.walletKey
  // (the shared `<prefix>:<wallet-lc-no-0x>:<suffix>` builder). Byte-identical
  // to the old inline form: walletKey lowercases + strips 0x exactly as the
  // old `.toLowerCase().replace(/^0x/, "")` did, and the audit-specific
  // `<stamp>:<receiptId>` two-segment suffix is the security-boundary key
  // shape (kept local to audit).
  return walletKey("audit", walletPubkey, `${stamp}:${receiptId}`);
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
  // W26-A: list-prefix via covenant-core.walletKey (empty suffix → the
  // "audit:<wallet>:" list-prefix form). Byte-identical to the old inline.
  const prefix = walletKey("audit", walletPubkey, "");

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
