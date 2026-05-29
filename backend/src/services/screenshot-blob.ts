/**
 * Screenshot-blob service — v7.2.0-preview.0 Day-5 SWARM worker D, 2026-05-28.
 *
 * Gen 1:20 — *"let the waters bring forth abundantly the moving creature."*
 * Matt 13:31-32 — *"the mustard seed... the least of all seeds; but when it
 * is grown, it is the greatest among herbs, and becometh a tree."*
 *
 * Purpose: store agent-captured page screenshots as content-addressable
 * blobs in KV, return a pointer URL (`unbrowse-blob://<sigKey>`) that
 * stands in for the local file path the v6/legacy handler wrote to
 * `~/.unbrowse/screenshots/`. Under `UNBROWSE_STATELESS=1` the local PNG
 * never lands on disk (A1 falsifier — pointers not payloads).
 *
 * Storage doctrine:
 *
 *   - Metadata is wallet-signed Ed25519 (v7.0 sig-shape). Body carries
 *     `{sessionId, urlHash, blobSha256, capturedAt, nonce}` — NEVER the
 *     URL, NEVER the page title, NEVER any cleartext. `urlHash` is a
 *     sha256 of the URL the caller observed (so we can group by domain
 *     without storing the URL itself).
 *   - The blob bytes are content-addressed by `sha256(blob)`. Two agents
 *     screenshotting the same page (identical bytes) hash to the same
 *     `blobSha256`; the binary lands once, the metadata rows differ. The
 *     metadata signature is NOT over the blob — `blobSha256` (the
 *     content address) is in the signed fragment, so verifying the sig
 *     transitively binds the metadata to the bytes.
 *   - The *primary* lookup key is the `sigKey = sha256(signature)[:32]`
 *     (same shape as TRACE_STATE / AUDIT_LOG). Two writes:
 *       1. `screenshot:<wallet>:<sigKey>:meta`  →  metadata envelope JSON
 *       2. `screenshot:<wallet>:<sigKey>:blob`  →  raw PNG bytes
 *     Keeping them in adjacent KV keys (suffix-differentiated) means a
 *     single KV list with `prefix="screenshot:<wallet>:<sigKey>"` walks
 *     both. (We could split into a content-addressed `cas:<blobSha256>`
 *     namespace for dedup — deferred to v7.3 when R2/Tigris-backed
 *     storage lands; in v7.2.0-preview.0 the binding may be inert.)
 *
 * Inert-fallback (load-bearing per Day-4 A5 lost-sheep rule):
 * When `env.SCREENSHOT_BLOB` is undefined the route returns 503 with
 * `{_binding_missing: "SCREENSHOT_BLOB"}`; the CLI handler treats this
 * as graceful-degrade and writes the bytes to
 * `~/.unbrowse/tmp/<sigKey>/screenshot.png` (per A1's tmp-path exclusion
 * — see A1 falsifier excluding any path-segment named "tmp") so replay
 * is still possible. NEVER under `~/.unbrowse/screenshots/`.
 *
 * Pointer scheme: `unbrowse-blob://<sigKey>`. Distinct from the W18
 * `unbrowse://` value pointer family — the `-blob` suffix tells adapters
 * to route via `GET /v1/screenshot/by-sigkey/<sigKey>` rather than the
 * value-pointer resolver.
 *
 * Heb 4:13 — *"all things are naked and opened unto the eyes of him
 * with whom we have to do"*: every pixel is sigKey-witnessed.
 */

import type { Env } from "../types.js";
import {
  hexToBytes,
  bytesToHex,
  deriveCacheKey as coreDeriveCacheKey,
  sha256Hex as coreSha256Hex,
  verifyEd25519,
  assertNoCleartext,
  type ValidationError as CoreValidationError,
} from "./covenant-core.js";

// Re-export the shared hex helpers under their historical names.
export { hexToBytes, bytesToHex };

// ─── Signature scheme discriminator ────────────────────────────────────────

export type ScreenshotBlobSignatureScheme = "ed25519-v7.0" | "groth16-v7.3";

const SIGNATURE_HEX_LENGTH: Partial<Record<ScreenshotBlobSignatureScheme, number>> = {
  "ed25519-v7.0": 128, // 64 bytes
} as const;

// ─── Hex / base64 shape regexes (validation-only, not crypto) ──────────────

const HEX_RE = /^[0-9a-fA-F]+$/;
const BASE64_RE = /^[A-Za-z0-9+/]+={0,2}$/;
const URL_SAFE_BASE64_RE = /^[A-Za-z0-9+/=]+$/;

// ─── Body shapes ───────────────────────────────────────────────────────────

/**
 * The signed metadata fragment. Pointer-shaped only — no URL, no title,
 * no headers, no body. `urlHash` is `sha256(url)[:32]` so the agent can
 * later group by domain offline without the URL itself crossing the
 * firmament.
 *
 * The blob bytes are NOT in this body; they ride alongside in
 * `blobBase64`. The signature is computed over the canonical-JSON of
 * `{sessionId, urlHash, blobSha256, capturedAt, nonce}` — `blobSha256`
 * binds the bytes transitively (any byte change → different sha → sig
 * verify fails).
 */
export interface ScreenshotStoreBody {
  walletPubkey: string;                          // 64-char hex
  signatureScheme?: ScreenshotBlobSignatureScheme; // defaults to ed25519-v7.0
  signature: string;                             // 128-char hex (Ed25519)
  nonce: string;                                 // base64 32 bytes (43-44 chars)
  sessionId: string;                             // pointer back to SESSION_STATE
  urlHash: string;                               // sha256(url)[:32] — 32 hex chars
  blobSha256: string;                            // sha256(blob_bytes) — 64 hex chars
  capturedAt: number;                            // unix ms
  blobBase64: string;                            // raw PNG bytes, base64-encoded
}

export interface StoredScreenshotMeta {
  sessionId: string;
  urlHash: string;
  blobSha256: string;
  capturedAt: number;
  walletPubkey: string;
  signatureScheme: ScreenshotBlobSignatureScheme;
  signature: string;
  nonce: string;
  cacheKey: string;                              // sha256(sig)[:32]
  blob_bytes: number;                            // raw byte length (post-decode)
  received_at: number;                           // unix ms
  verify_ok: boolean;
}

// ─── Canonical JSON ────────────────────────────────────────────────────────

/**
 * The signed fragment. `blobSha256` is in the signed payload so the sig
 * transitively binds the bytes (no sig over the blob itself — that would
 * double the wire footprint without changing the security claim).
 *
 * Key order MUST match the CLI's `signableFields` passed to
 * `postStateless` so the sig verifies. Order: sessionId, urlHash,
 * blobSha256, capturedAt, nonce.
 */
export function canonicalizeSignedFragment(body: ScreenshotStoreBody): string {
  return JSON.stringify({
    sessionId: body.sessionId,
    urlHash: body.urlHash,
    blobSha256: body.blobSha256,
    capturedAt: body.capturedAt,
    nonce: body.nonce,
  });
}

// ─── Cache-key derivation ──────────────────────────────────────────────────

/** sigKey = sha256(signature)[:32]. Hex-encoded, 32 chars. */
export async function deriveSigKey(signature: Uint8Array): Promise<string> {
  return coreDeriveCacheKey(signature);
}

export async function deriveSigKeyHex(signatureHex: string): Promise<string> {
  return deriveSigKey(hexToBytes(signatureHex));
}

/**
 * Compute sha256(bytes) → 64-char hex. Convenience for blob CAS — the binary
 * content-address (NOT a pointer; the blob bytes are the one payload that
 * genuinely cannot converge to pointer-only).
 */
export async function sha256Hex(bytes: Uint8Array): Promise<string> {
  return coreSha256Hex(bytes);
}

// ─── Pointer URL ───────────────────────────────────────────────────────────

/** `unbrowse-blob://<sigKey>` — the pointer the CLI prints in stateless mode. */
export const POINTER_SCHEME = "unbrowse-blob://" as const;

export function buildPointerUrl(sigKey: string): string {
  return `${POINTER_SCHEME}${sigKey}`;
}

export function parsePointerUrl(url: string): { sigKey: string } | null {
  if (!url.startsWith(POINTER_SCHEME)) return null;
  const sigKey = url.slice(POINTER_SCHEME.length);
  if (sigKey.length !== 32 || !HEX_RE.test(sigKey)) return null;
  return { sigKey };
}

// ─── Schema validation ─────────────────────────────────────────────────────

export type ValidationError = CoreValidationError;

const SCREENSHOT_FORBIDDEN_REASON =
  "forbidden — screenshot-blob metadata carries hashed/pointer fields only " +
  "(urlHash, blobSha256); raw URLs/titles/headers never cross this surface";

/**
 * Screenshot-metadata no-cleartext gate. Delegates the field-match to the
 * shared `assertNoCleartext` (covenant-core) and stamps the screenshot reason.
 * The covenant-core default forbidden list is a superset of screenshot-blob's
 * historical list (including `title`). Only the metadata receipt converges to
 * pointer-only here — the blob bytes themselves are real binary payload in a
 * separate KV key (the honest non-convergence boundary).
 */
function hasForbiddenField(body: Record<string, unknown>): ValidationError | null {
  const hit = assertNoCleartext(body);
  if (!hit) return null;
  return { field: hit.field, reason: SCREENSHOT_FORBIDDEN_REASON };
}

/** Cap on the decoded blob size (bytes). PNGs >8MB are vanishingly rare; reject. */
export const MAX_BLOB_BYTES = 8 * 1024 * 1024;

export function validateScreenshotStoreBody(raw: unknown): ValidationError | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return { field: "$body", reason: "body must be a JSON object" };
  }
  const body = raw as Record<string, unknown>;

  const forbidden = hasForbiddenField(body);
  if (forbidden) return forbidden;

  // Required string fields
  for (const f of [
    "walletPubkey",
    "signature",
    "nonce",
    "sessionId",
    "urlHash",
    "blobSha256",
    "blobBase64",
  ]) {
    const v = body[f];
    if (typeof v !== "string" || v.length === 0) {
      return { field: f, reason: "required string field missing or empty" };
    }
  }

  if (typeof body.capturedAt !== "number" || !Number.isFinite(body.capturedAt)) {
    return { field: "capturedAt", reason: "must be a finite unix-ms number" };
  }

  // Signature scheme
  const rawScheme = body.signatureScheme;
  if (rawScheme !== undefined && rawScheme !== null) {
    if (typeof rawScheme !== "string") {
      return { field: "signatureScheme", reason: "must be a string when present" };
    }
    if (!(rawScheme in SIGNATURE_HEX_LENGTH)) {
      return { field: "signatureScheme", reason: `unsupported scheme '${rawScheme}'` };
    }
  }
  const scheme = (rawScheme as ScreenshotBlobSignatureScheme | undefined) ?? "ed25519-v7.0";

  // Wallet pubkey — 32-byte hex
  const walletPubkey = body.walletPubkey as string;
  const walletClean = walletPubkey.startsWith("0x") ? walletPubkey.slice(2) : walletPubkey;
  if (walletClean.length !== 64 || !HEX_RE.test(walletClean)) {
    return { field: "walletPubkey", reason: "must be 32-byte hex (64 chars)" };
  }

  // Signature — scheme-aware
  const signature = body.signature as string;
  const sigClean = signature.startsWith("0x") ? signature.slice(2) : signature;
  const expectedLen = SIGNATURE_HEX_LENGTH[scheme];
  if (expectedLen === undefined) {
    return { field: "signatureScheme", reason: `scheme '${scheme}' has no pinned length yet` };
  }
  if (sigClean.length !== expectedLen || !HEX_RE.test(sigClean)) {
    return { field: "signature", reason: `must be ${expectedLen}-char ${scheme} hex` };
  }

  // Nonce — base64 32 bytes
  const nonce = body.nonce as string;
  if (!BASE64_RE.test(nonce) || nonce.length < 43 || nonce.length > 44) {
    return { field: "nonce", reason: "must be base64-encoded 32 bytes (43-44 chars)" };
  }

  // sessionId — short string
  const sessionId = body.sessionId as string;
  if (sessionId.length > 256) {
    return { field: "sessionId", reason: "must be <= 256 chars" };
  }

  // urlHash — 32-char hex (sha256(url)[:32])
  const urlHash = body.urlHash as string;
  if (urlHash.length !== 32 || !HEX_RE.test(urlHash)) {
    return { field: "urlHash", reason: "must be 32 hex chars (sha256(url) truncated)" };
  }

  // blobSha256 — full 64-char hex
  const blobSha256 = (body.blobSha256 as string).toLowerCase();
  if (blobSha256.length !== 64 || !HEX_RE.test(blobSha256)) {
    return { field: "blobSha256", reason: "must be 64 hex chars (sha256(blob))" };
  }

  // blobBase64 — base64; cap decoded size at MAX_BLOB_BYTES
  const blobBase64 = body.blobBase64 as string;
  if (!URL_SAFE_BASE64_RE.test(blobBase64)) {
    return { field: "blobBase64", reason: "must be base64-encoded bytes" };
  }
  // Conservative upper-bound on decoded length: base64 grows by 4/3.
  const approxDecoded = Math.floor((blobBase64.length * 3) / 4);
  if (approxDecoded > MAX_BLOB_BYTES) {
    return {
      field: "blobBase64",
      reason: `decoded blob exceeds ${MAX_BLOB_BYTES} bytes cap`,
    };
  }

  return null;
}

// ─── Ed25519 verification ──────────────────────────────────────────────────

export async function verifyScreenshotStoreSignature(
  body: ScreenshotStoreBody,
): Promise<boolean> {
  const canonical = canonicalizeSignedFragment(body);
  const dataBytes = new TextEncoder().encode(canonical);
  return verifyEd25519(body.walletPubkey, body.signature, dataBytes);
}

// ─── KV key derivation ─────────────────────────────────────────────────────

export function screenshotKeyPrefix(walletPubkey: string): string {
  const wallet = walletPubkey.toLowerCase().replace(/^0x/, "");
  return `screenshot:${wallet}:`;
}

export function metaPrimaryKey(walletPubkey: string, sigKey: string): string {
  return `${screenshotKeyPrefix(walletPubkey)}${sigKey}:meta`;
}

export function blobPrimaryKey(walletPubkey: string, sigKey: string): string {
  return `${screenshotKeyPrefix(walletPubkey)}${sigKey}:blob`;
}

// ─── KV storage ────────────────────────────────────────────────────────────

export class BindingMissingError extends Error {
  readonly code = "screenshot_blob_binding_missing";
  readonly namespace = "SCREENSHOT_BLOB";
  constructor() {
    super(
      "env.SCREENSHOT_BLOB is undefined — operator must run " +
        "`bunx wrangler kv:namespace create SCREENSHOT_BLOB` (and `--preview`), " +
        "then paste the ids into backend/wrangler.toml.",
    );
    this.name = "BindingMissingError";
  }
}

function requireScreenshotBlob(env: Env): KVNamespace {
  if (!env.SCREENSHOT_BLOB) throw new BindingMissingError();
  return env.SCREENSHOT_BLOB;
}

/** 30d TTL — screenshots are recomputable forensic evidence, not durable canon. */
const SCREENSHOT_TTL_SECONDS = 30 * 24 * 60 * 60;

/**
 * Persist a screenshot row: two KV writes (meta + blob), keyed by
 * sigKey. Idempotent — a second POST with the same body yields the
 * same sigKey and is a no-op.
 */
export async function persistScreenshotRow(
  env: Env,
  body: ScreenshotStoreBody,
  verifyOk: boolean,
  blobBytes: Uint8Array,
  nowMs: number = Date.now(),
): Promise<{ sigKey: string; metaKey: string; blobKey: string; idempotent: boolean }> {
  const kv = requireScreenshotBlob(env);
  const sigKey = await deriveSigKeyHex(body.signature);
  const metaKey = metaPrimaryKey(body.walletPubkey, sigKey);
  const blobKey = blobPrimaryKey(body.walletPubkey, sigKey);

  const existing = await kv.get(metaKey);
  if (existing) {
    return { sigKey, metaKey, blobKey, idempotent: true };
  }

  const meta: StoredScreenshotMeta = {
    sessionId: body.sessionId,
    urlHash: body.urlHash,
    blobSha256: body.blobSha256.toLowerCase(),
    capturedAt: body.capturedAt,
    walletPubkey: body.walletPubkey.toLowerCase().replace(/^0x/, ""),
    signatureScheme: body.signatureScheme ?? "ed25519-v7.0",
    signature: body.signature.toLowerCase(),
    nonce: body.nonce,
    cacheKey: sigKey,
    blob_bytes: blobBytes.byteLength,
    received_at: nowMs,
    verify_ok: verifyOk,
  };

  await Promise.all([
    kv.put(metaKey, JSON.stringify(meta), { expirationTtl: SCREENSHOT_TTL_SECONDS }),
    kv.put(blobKey, blobBytes, { expirationTtl: SCREENSHOT_TTL_SECONDS }),
  ]);

  return { sigKey, metaKey, blobKey, idempotent: false };
}

export async function readScreenshotMeta(
  env: Env,
  walletPubkey: string,
  sigKey: string,
): Promise<StoredScreenshotMeta | null> {
  const kv = requireScreenshotBlob(env);
  const raw = await kv.get(metaPrimaryKey(walletPubkey, sigKey));
  if (!raw) return null;
  try {
    return JSON.parse(raw) as StoredScreenshotMeta;
  } catch {
    return null;
  }
}

export async function readScreenshotBlob(
  env: Env,
  walletPubkey: string,
  sigKey: string,
): Promise<ArrayBuffer | null> {
  const kv = requireScreenshotBlob(env);
  return kv.get(blobPrimaryKey(walletPubkey, sigKey), "arrayBuffer");
}
