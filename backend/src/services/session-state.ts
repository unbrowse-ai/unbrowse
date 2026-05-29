/**
 * Session-state service — v7.2.0-preview.0 (W23 wave, 2026-05-28).
 *
 * Persistent-session storage substrate for the "breath close is antipattern"
 * directive. Mirror of the W4/W8 audit service pattern (`services/audit.ts`):
 * Ed25519 schema gate + canonical-JSON receipt-id + KV namespace declaration.
 *
 * Status in v7.2.0-preview.0: SCHEMA + VERIFY are REAL; STORAGE path is
 * INERT (returns BindingMissingError when SESSION_STATE binding absent,
 * which the route maps to a 503 honest-empty envelope). v7.3+ ships the
 * real KV impl (mirror of `persistAuditRow` / `readAuditRowByReceiptId`).
 *
 * Doctrine — Mt 6:19-20 — "Lay up for yourselves treasures in heaven,
 * where neither moth nor rust corrupts." The KV-cached pointer-chain IS
 * the persistent treasure that browser-close was destroying every
 * session — laid up where moth nor rust corrupts (the wallet-gated KV
 * row), reached only through the owning wallet (the only key that
 * opens that storehouse).
 *
 * Operator provisioning (one-time, BEFORE deploying the v7.3 wave that
 * wires real storage):
 *   bunx wrangler kv:namespace create SESSION_STATE
 *   bunx wrangler kv:namespace create SESSION_STATE --preview
 * Then paste the returned ids into `backend/wrangler.toml`'s
 * SESSION_STATE stanza in place of the TODO placeholders. Until then,
 * the routes return 503 with `{error: "session_state_binding_inert"}`
 * so the deploy-shape problem is loud and the operator knows to provision.
 *
 * ─── KV namespace: SESSION_STATE ───────────────────────────────────────────
 *
 * One key shape, wallet-prefixed for structural cross-wallet protection:
 *
 *   session:<walletPubkey-hex-lowercase>:<sessionId>
 *     → JSON blob of ParkedSessionRow (see types below).
 *
 * Wallet-pubkey prefix is THE security boundary. A read attempt by
 * wallet-A signing a challenge for sessionId X tries to read
 * `session:<walletA>:X`. wallet-B's session at `session:<walletB>:X`
 * is at a DIFFERENT key — structurally unreachable from wallet-A's
 * derived prefix. Cross-wallet enumeration is impossible at the
 * row-naming layer; the signature verification is defense-in-depth.
 *
 * TTL: rolling 24h. Every successful restore-read resets the row's
 * `expirationTtl` via a re-put.
 *
 * ─── Critical invariant (Deut 19:15 — two witnesses) ───────────────────────
 *
 * The body MUST NOT contain L0 cleartext at any nesting depth:
 *   - No cookie VALUES (cookie names/domains/expires are fine — same
 *     pattern as `eval cookies` and W21 auth-inventory).
 *   - No fill values, no header values.
 *   - No resolved L0 bytes from any vault adapter.
 *   - No page bodies, AX trees, screenshots.
 *
 * The schema gate `validateSessionParkBody` rejects any field whose
 * canonical name matches the forbidden-list (mirrors `validateAuditBody`).
 */

import type { Env } from "../types.js";
import {
  // W26-A: shared substrate primitives (Eph 4:4 — one body). Deletes the
  // session-local hex/canonical/Ed25519/forbidden-field/wallet-key copies
  // and routes them through covenant-core. Byte-compat preserved — the
  // session-specific canonicalizer still produces the canonical input.
  hexToBytes,
  bytesToHex,
  canonicalize,
  deriveReceiptId as deriveReceiptIdFromCanonical,
  verifyEd25519,
  verifyWalletChallenge,
  assertNoCleartext,
  walletKey,
} from "./covenant-core.js";

// ─── Signature scheme discriminator (v7.2 = Ed25519; v7.3 = Groth16) ───────

export type SessionStateSignatureScheme = "ed25519-v7.2" | "groth16-v7.3";

/** Per-scheme expected hex length of `signature`. Mirrors audit.ts. */
const SIGNATURE_HEX_LENGTH: Partial<Record<SessionStateSignatureScheme, number>> = {
  "ed25519-v7.2": 128, // 64 bytes
  // "groth16-v7.3": <pin once circuit is frozen>
} as const;

// ─── Hex / regex helpers ───────────────────────────────────────────────────
//
// W26-A: hexToBytes/bytesToHex deleted — imported from covenant-core and
// re-exported so session-state's public surface is unchanged. HEX_RE stays
// local — it's the schema-gate's character-class check, not a crypto
// primitive.
export { hexToBytes, bytesToHex };

const HEX_RE = /^[0-9a-fA-F]+$/;

// ─── Body shape ────────────────────────────────────────────────────────────

export interface BoundPointer {
  l1_pointer: string;       // op://Vault/Item/field  (the L1 pointer)
  l2_context_hash: string;  // 64-char hex: sha256(l1 || url || selector || bucket)
  l3_zk_sig: string;        // 128-char hex (Ed25519 in v7.2; 400 chars Groth16 in v7.3)
  l4_cache_key: string;     // 64-char hex: sha256(l3_zk_sig)
  last_used_at: number;     // unix ms
  expires_at: number;       // unix ms
}

export interface SessionParkBody {
  // Pointer-only session triple
  sessionId: string;
  targetUrl: string;
  targetId: string;
  contextId: string;

  // Pointer-of-pointer registry (L1..L4) — see scope §2.1
  boundPointers: BoundPointer[];

  // Discovered API surface — hash only, NEVER the endpoints themselves.
  capturedEndpointsHash: string; // 64-char hex
  // Optional refs to sibling waves' captured artifacts.
  specHitRef?: string;            // sha256 hex of spec descriptor (W22)
  cookiesInventoryRef?: string;   // sha256 hex of inventory blob (W21)

  // Ownership + auth
  walletPubkey: string; // 64-char hex (32-byte Ed25519 pubkey)
  signatureScheme?: SessionStateSignatureScheme; // defaults to ed25519-v7.2
  signature: string;     // hex over canonical signed-fragment

  parked_at: number; // unix ms when client emitted the park request
}

export interface StoredSessionRow extends SessionParkBody {
  received_at: number;
  verify_ok: boolean;
  // Rolling counter for restores — every successful restore bumps this.
  last_query_at: number;
}

// ─── Canonical JSON ────────────────────────────────────────────────────────

/**
 * Canonical signed fragment — what the wallet signs. Fixed key order so
 * client + server agree on bytes. Mirrors `canonicalizeSignedFragment`
 * pattern from audit.ts.
 *
 * The boundPointers array is canonicalized element-wise to keep nested
 * key order deterministic.
 */
/**
 * Top-level field order for the signed fragment. The nested boundPointers
 * elements are canonicalized element-wise BELOW (covenant-core.canonicalize
 * only projects the top level), then the whole object's order-projection is
 * routed through covenant-core so the insertion-order stringify is shared.
 */
const SESSION_SIGNED_FRAGMENT_ORDER = [
  "sessionId",
  "targetUrl",
  "targetId",
  "contextId",
  "boundPointers",
  "capturedEndpointsHash",
  "specHitRef",
  "cookiesInventoryRef",
  "walletPubkey",
  "parked_at",
] as const;

export function canonicalizeSignedFragment(body: SessionParkBody): string {
  // W26-A: nested boundPointers canonicalization stays local (covenant-core
  // only does top-level projection); the top-level order-projection is shared
  // via covenant-core.canonicalize. Byte-identical to the old literal —
  // specHitRef/cookiesInventoryRef absent → null (same as the old `?? null`),
  // and every other field is required.
  const pointersCanonical = body.boundPointers.map((bp) => ({
    l1_pointer: bp.l1_pointer,
    l2_context_hash: bp.l2_context_hash,
    l3_zk_sig: bp.l3_zk_sig,
    l4_cache_key: bp.l4_cache_key,
    last_used_at: bp.last_used_at,
    expires_at: bp.expires_at,
  }));
  return canonicalize(
    {
      sessionId: body.sessionId,
      targetUrl: body.targetUrl,
      targetId: body.targetId,
      contextId: body.contextId,
      boundPointers: pointersCanonical,
      capturedEndpointsHash: body.capturedEndpointsHash,
      specHitRef: body.specHitRef,
      cookiesInventoryRef: body.cookiesInventoryRef,
      walletPubkey: body.walletPubkey,
      parked_at: body.parked_at,
    },
    SESSION_SIGNED_FRAGMENT_ORDER,
  );
}

/** Full-body canonical JSON — input to receiptId derivation. */
export function canonicalizeFullBody(body: SessionParkBody): string {
  return JSON.stringify({
    ...JSON.parse(canonicalizeSignedFragment(body)),
    signatureScheme: body.signatureScheme ?? "ed25519-v7.2",
    signature: body.signature,
  });
}

/** Deterministic receiptId — caller can predict before sending. */
export async function deriveReceiptId(body: SessionParkBody): Promise<string> {
  // W26-A: hash mechanism delegated to covenant-core.deriveReceiptId (same
  // sha256→hex). The session-specific canonicalizer still produces the
  // canonical input, so every existing parked-session receiptId is unchanged.
  return deriveReceiptIdFromCanonical(canonicalizeFullBody(body));
}

// ─── Schema validation ─────────────────────────────────────────────────────

export interface ValidationError {
  field: string;
  reason: string;
}

/**
 * W26-A: the session-local FORBIDDEN_FIELDS list + hasForbiddenField are
 * deleted (Eph 4:4); the shared covenant-core.assertNoCleartext is the one
 * gate. The session list was a subset of DEFAULT_FORBIDDEN_FIELDS, so the
 * widened union only rejects MORE cleartext-shaped fields — never loosens.
 * `targetUrl` is the only url-bearing field and it does NOT collide with the
 * forbidden name `url` (assertNoCleartext matches whole field names, not
 * substrings), so the legitimate session body still validates.
 *
 * The shared gate matches case-insensitively at the top level. It is invoked
 * BOTH on the top-level body AND on each BoundPointer element (same two call
 * sites the old hasForbiddenField had).
 */

/**
 * Schema gate. Returns null on success or a ValidationError describing the
 * first failure. Enforces the no-L0-cleartext invariant.
 */
export function validateSessionParkBody(raw: unknown): ValidationError | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return { field: "$body", reason: "body must be a JSON object" };
  }
  const body = raw as Record<string, unknown>;

  // Forbidden-list gate — first witness against L0-leakage (W26-A: shared
  // covenant-core.assertNoCleartext).
  const forbidden = assertNoCleartext(body);
  if (forbidden) return { field: forbidden.field, reason: forbidden.reason };

  // Required string fields.
  for (const f of ["sessionId", "targetUrl", "targetId", "contextId", "capturedEndpointsHash", "walletPubkey", "signature"]) {
    const v = body[f];
    if (typeof v !== "string" || v.length === 0) {
      return { field: f, reason: "required string field missing or empty" };
    }
  }
  if (typeof body.parked_at !== "number" || !Number.isFinite(body.parked_at)) {
    return { field: "parked_at", reason: "must be a finite number (unix ms)" };
  }

  // Signature scheme — optional, defaults to ed25519-v7.2.
  const rawScheme = body.signatureScheme;
  if (rawScheme !== undefined && rawScheme !== null) {
    if (typeof rawScheme !== "string") {
      return { field: "signatureScheme", reason: "must be a string when present" };
    }
    if (!(rawScheme in SIGNATURE_HEX_LENGTH)) {
      return { field: "signatureScheme", reason: `unsupported scheme '${rawScheme}'` };
    }
  }
  const scheme: SessionStateSignatureScheme = (rawScheme as SessionStateSignatureScheme | undefined) ?? "ed25519-v7.2";

  // Wallet pubkey — 32-byte hex.
  const walletPubkey = body.walletPubkey as string;
  const walletClean = walletPubkey.startsWith("0x") ? walletPubkey.slice(2) : walletPubkey;
  if (walletClean.length !== 64 || !HEX_RE.test(walletClean)) {
    return { field: "walletPubkey", reason: "must be 32-byte hex (64 chars)" };
  }

  // Signature — scheme-aware hex length.
  const signature = body.signature as string;
  const sigClean = signature.startsWith("0x") ? signature.slice(2) : signature;
  const expectedLen = SIGNATURE_HEX_LENGTH[scheme];
  if (expectedLen === undefined) {
    return { field: "signatureScheme", reason: `scheme '${scheme}' has no pinned signature length yet` };
  }
  if (sigClean.length !== expectedLen || !HEX_RE.test(sigClean)) {
    return { field: "signature", reason: `must be ${expectedLen / 2}-byte ${scheme} hex (${expectedLen} chars)` };
  }

  // capturedEndpointsHash — sha256 hex.
  const ceh = body.capturedEndpointsHash as string;
  const cehClean = ceh.startsWith("0x") ? ceh.slice(2) : ceh;
  if (cehClean.length !== 64 || !HEX_RE.test(cehClean)) {
    return { field: "capturedEndpointsHash", reason: "must be sha256 hex (64 chars)" };
  }

  // Optional hashes.
  for (const f of ["specHitRef", "cookiesInventoryRef"]) {
    const v = body[f];
    if (v === undefined || v === null) continue;
    if (typeof v !== "string") {
      return { field: f, reason: "must be a string when present" };
    }
    const clean = v.startsWith("0x") ? v.slice(2) : v;
    if (clean.length !== 64 || !HEX_RE.test(clean)) {
      return { field: f, reason: "must be sha256 hex (64 chars) when present" };
    }
  }

  // boundPointers — must be array; each element validated structurally.
  if (!Array.isArray(body.boundPointers)) {
    return { field: "boundPointers", reason: "must be an array" };
  }
  if (body.boundPointers.length > 1024) {
    return { field: "boundPointers", reason: "must contain at most 1024 entries" };
  }
  for (let i = 0; i < body.boundPointers.length; i++) {
    const bp = body.boundPointers[i] as Record<string, unknown>;
    if (!bp || typeof bp !== "object") {
      return { field: `boundPointers[${i}]`, reason: "must be an object" };
    }
    // Forbidden-list also applies inside each BoundPointer (W26-A: shared gate).
    const innerForbidden = assertNoCleartext(bp);
    if (innerForbidden) {
      return { field: `boundPointers[${i}].${innerForbidden.field}`, reason: innerForbidden.reason };
    }
    // l1_pointer must look like a URI (op://, keychain://, unbrowse://, arg://, …)
    const l1 = bp.l1_pointer;
    if (typeof l1 !== "string" || !/^[a-z][a-z0-9+\-.]*:\/\/.+/.test(l1)) {
      return { field: `boundPointers[${i}].l1_pointer`, reason: "must be a URI like op://... or keychain://..." };
    }
    // The three hash fields.
    for (const hashField of ["l2_context_hash", "l4_cache_key"] as const) {
      const v = bp[hashField];
      if (typeof v !== "string") {
        return { field: `boundPointers[${i}].${hashField}`, reason: "must be a string" };
      }
      const clean = v.startsWith("0x") ? v.slice(2) : v;
      if (clean.length !== 64 || !HEX_RE.test(clean)) {
        return { field: `boundPointers[${i}].${hashField}`, reason: "must be sha256 hex (64 chars)" };
      }
    }
    // l3 is scheme-aware
    const l3 = bp.l3_zk_sig;
    if (typeof l3 !== "string") {
      return { field: `boundPointers[${i}].l3_zk_sig`, reason: "must be a string" };
    }
    const l3Clean = l3.startsWith("0x") ? l3.slice(2) : l3;
    if (l3Clean.length !== expectedLen || !HEX_RE.test(l3Clean)) {
      return { field: `boundPointers[${i}].l3_zk_sig`, reason: `must be ${expectedLen}-char hex under ${scheme}` };
    }
    // Timestamps
    for (const tsField of ["last_used_at", "expires_at"] as const) {
      if (typeof bp[tsField] !== "number" || !Number.isFinite(bp[tsField] as number)) {
        return { field: `boundPointers[${i}].${tsField}`, reason: "must be a finite number (unix ms)" };
      }
    }
  }

  return null;
}

// ─── Ed25519 verification (REAL in v7.2; SNARK swaps in at v7.3) ───────────

export async function verifySessionParkSignature(body: SessionParkBody): Promise<boolean> {
  // W26-A: Ed25519 import+verify delegated to covenant-core.verifyEd25519
  // (same 32-byte-key / 64-byte-sig gates, same catch-returns-false). The
  // session-specific signed-fragment construction stays here.
  const canonical = canonicalizeSignedFragment(body);
  const dataBytes = new TextEncoder().encode(canonical);
  return verifyEd25519(body.walletPubkey, body.signature, dataBytes);
}

/**
 * Verify the restore-challenge signature: Ed25519 over
 * `<sessionId> || ":" || <timestamp>` under the supplied walletPubkey.
 *
 * The colon delimiter prevents the trivial concat-ambiguity attack
 * (e.g. sessionId="abc" + timestamp="123" colliding with sessionId="ab"
 * + timestamp="c123").
 */
export async function verifyRestoreChallenge(
  sessionId: string,
  timestampMs: number,
  walletPubkeyHex: string,
  sigHex: string,
): Promise<boolean> {
  // W26-A: delegated to covenant-core.verifyWalletChallenge — the shared
  // `<challenge>:<timestamp>` colon-joined GET-challenge verifier (sessionId
  // is the challenge token). maxAgeMs=0 preserves the current pure-verify
  // behavior (no staleness window); W26-C may tighten the route to pass a
  // real window without changing this signature. Byte-identical message:
  // `${sessionId}:${timestampMs}`, same Ed25519 length gates + catch-false.
  return verifyWalletChallenge(sessionId, sigHex, walletPubkeyHex, timestampMs, 0);
}

// ─── KV key derivation ─────────────────────────────────────────────────────

/**
 * The wallet-prefixed primary key. This shape is THE security boundary —
 * a request signing wallet-A can only resolve to a key starting with
 * `session:<walletA-hex>:`; wallet-B's rows live under a different
 * prefix and are structurally unreachable.
 */
export function sessionPrimaryKey(walletPubkey: string, sessionId: string): string {
  // W26-A: wallet-prefix construction via covenant-core.walletKey. The
  // `<sessionId>` suffix (the per-session idem segment, NOT a sig-hash) stays
  // session-specific. Byte-identical: walletKey lowercases + strips 0x
  // exactly as the old inline. This wallet-prefix IS the cross-wallet
  // security boundary (wallet-A cannot resolve a key under wallet-B's prefix).
  return walletKey("session", walletPubkey, sessionId);
}

// ─── Inert storage path (v7.2.0-preview.0) ────────────────────────────────

/**
 * BindingMissingError — thrown when `env.SESSION_STATE` is absent. Maps
 * to a 503 honest envelope at the route layer. Mirrors the W8 audit
 * pattern: the impl is wired and graceful-degrades to a 503 + operator
 * instruction so the deployment-shape problem surfaces loud.
 *
 * v7.2.0-preview.0 reality: this error fires on EVERY call because the
 * wrangler.toml still has TODO placeholders. v7.3 wave provisions the
 * namespace and this error becomes a "configuration drift" canary.
 */
export class BindingMissingError extends Error {
  readonly code = "session_state_binding_missing";
  constructor() {
    super(
      "env.SESSION_STATE is undefined — operator must run `bunx wrangler kv:namespace create SESSION_STATE` (and `--preview`), then paste the ids into backend/wrangler.toml. v7.2.0-preview.0 routes return 503 honestly when this fires; v7.3 wave wires the real storage path.",
    );
    this.name = "BindingMissingError";
  }
}

function requireSessionState(env: Env): KVNamespace {
  if (!env.SESSION_STATE) throw new BindingMissingError();
  return env.SESSION_STATE;
}

/**
 * Persist a parked-session row.
 *
 * v7.2.0-preview.0: when `env.SESSION_STATE` is absent, the function
 * throws BindingMissingError and the route returns 200 + `parked: false`
 * (we never block the client teardown on storage). When the binding IS
 * present (v7.3+ provisioned), writes to KV with 24h TTL.
 *
 * Idempotency: receiptId is deterministic over the canonical body. A
 * second park of the SAME body produces the same receiptId and the
 * underlying KV put is a no-op (same key, same value) — natively
 * idempotent.
 */
export async function persistParkedSession(
  env: Env,
  body: SessionParkBody,
  verifyOk: boolean,
  nowMs: number = Date.now(),
): Promise<{ receiptId: string; primaryKey: string; idempotent: boolean }> {
  const kv = requireSessionState(env); // throws BindingMissingError if absent
  const receiptId = await deriveReceiptId(body);
  const primaryKey = sessionPrimaryKey(body.walletPubkey, body.sessionId);

  // Idempotency probe — same body produces same JSON.
  const existing = await kv.get(primaryKey);
  if (existing) {
    try {
      const existingRow = JSON.parse(existing) as StoredSessionRow;
      const existingReceipt = await deriveReceiptId(existingRow);
      if (existingReceipt === receiptId) {
        return { receiptId, primaryKey, idempotent: true };
      }
    } catch {
      // Corrupt existing row — overwrite below.
    }
  }

  const storedRow: StoredSessionRow = {
    ...body,
    signatureScheme: body.signatureScheme ?? "ed25519-v7.2",
    received_at: nowMs,
    verify_ok: verifyOk,
    last_query_at: nowMs,
  };

  await kv.put(primaryKey, JSON.stringify(storedRow), {
    expirationTtl: 86400, // 24h rolling
  });

  return { receiptId, primaryKey, idempotent: false };
}

/**
 * Read a parked-session row by (walletPubkey, sessionId).
 *
 * The wallet-prefixed key is the structural cross-wallet protection:
 * caller can only resolve to rows under their own pubkey prefix.
 * Combined with the route-layer signature verification (the wallet
 * pubkey is derived from the verified signature, never user-supplied)
 * the access path is sealed at two layers (Deut 19:15).
 *
 * v7.2.0-preview.0: throws BindingMissingError when SESSION_STATE
 * binding is absent → route returns 503 honest-empty. v7.3+: returns
 * the row JSON or null.
 */
export async function readParkedSession(
  env: Env,
  walletPubkey: string,
  sessionId: string,
): Promise<StoredSessionRow | null> {
  const kv = requireSessionState(env);
  const key = sessionPrimaryKey(walletPubkey, sessionId);
  const raw = await kv.get(key);
  if (!raw) return null;
  try {
    return JSON.parse(raw) as StoredSessionRow;
  } catch {
    return null;
  }
}

/**
 * Bump `last_query_at` on a read — rolling 24h TTL. Best-effort: if the
 * write fails, the read still returns the row.
 */
export async function bumpLastQueryAt(
  env: Env,
  walletPubkey: string,
  sessionId: string,
  row: StoredSessionRow,
  nowMs: number = Date.now(),
): Promise<void> {
  try {
    const kv = requireSessionState(env);
    const key = sessionPrimaryKey(walletPubkey, sessionId);
    const updated: StoredSessionRow = { ...row, last_query_at: nowMs };
    await kv.put(key, JSON.stringify(updated), { expirationTtl: 86400 });
  } catch {
    // Honest no-op: the read still returns; the TTL extension is
    // best-effort and a failure here is forensically benign.
  }
}
