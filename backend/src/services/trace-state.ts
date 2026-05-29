/**
 * Trace-state service — v7.2.0-preview.0 (Day-3 Land worker B, 2026-05-28).
 *
 * Persistent execution-trace storage for the v7-rip stateless substrate.
 * Mirrors the W23 session-state pattern (`services/session-state.ts`):
 * Ed25519 schema gate + canonical-JSON receipt-id + KV namespace declaration.
 *
 * Conforms to the `StatelessNamespace<TBody>` interface declared in Day-2
 * boundary §G. Worker A is writing the canonical interface file at
 * `services/stateless-substrate.ts` in parallel — until that lands, this
 * module conforms to the interface SHAPE (Day-2 §G verbatim). Day-4
 * (Luminaries) bolts the imports together. The seed is the contract.
 *
 * Doctrine — Dan 7:10 — "the books were opened": traces are the books
 * the substrate reads from, sig-keyed so each wallet's books are bound
 * to its own steward (Heb 4:13). The decision_trace step labels + timings
 * + status codes ARE the contents; URL paths, response bodies, and
 * header values NEVER cross this surface.
 *
 * Operator provisioning (one-time, BEFORE deploying the v7.x wave that
 * wires real trace recall):
 *   bunx wrangler kv:namespace create TRACE_STATE
 *   bunx wrangler kv:namespace create TRACE_STATE --preview
 * Then paste the returned ids into `backend/wrangler.toml`'s TRACE_STATE
 * stanza (top-level + every env block).
 *
 * ─── KV namespace: TRACE_STATE ─────────────────────────────────────────────
 *
 * Key shape:
 *   trace:<walletPubkey-hex-lowercase>:<sigHashHex>
 *     where sigHashHex = sha256(signature)[:32]  (the cache_key, deriveCacheKey
 *     per §G constraint #2).
 *
 * Wallet-pubkey prefix is THE security boundary (Day-2 §H invariant #2).
 * A read attempt by wallet-A signing a challenge for sigHash X tries to
 * read `trace:<walletA>:X`; wallet-B's traces at `trace:<walletB>:X`
 * sit at a DIFFERENT key. Cross-wallet enumeration is impossible at
 * the row-naming layer; the signature verification is defense-in-depth.
 *
 * TTL: rolling 7d (per Day-2 §F decision: longer than SESSION_STATE
 * because traces inform ranker quality across reconnects; shorter than
 * AUDIT_LOG because traces are recomputable, audit rows are not).
 *
 * ─── Critical invariant (Day-2 §H #3 — forbidden cleartext) ────────────────
 *
 * The body MUST NOT contain L0 cleartext at any nesting depth. Forbidden
 * fields (case-insensitive, canonical-normalized):
 *   value | cleartext | secret | cookie | header | url | path | query
 *   | fillValue | cookieValue
 * Additionally, `traces[i].url` and `traces[i].path` are rejected with
 * extra prejudice (the v6 StoredTrace shape carried URL paths; v7 traces
 * carry domain-only, decision_trace step labels, and timings).
 */

import type { Env } from "../types.js";
import {
  hexToBytes,
  bytesToHex,
  deriveCacheKey as coreDeriveCacheKey,
  verifyEd25519,
  assertNoCleartext,
  type ValidationError as CoreValidationError,
} from "./covenant-core.js";

// Re-export the shared hex helpers under their historical names so any
// existing importer (and the byte-compat test surface) keeps the same API.
export { hexToBytes, bytesToHex };

// ─── Signature scheme discriminator ────────────────────────────────────────

export type TraceStateSignatureScheme = "ed25519-v7.0" | "groth16-v7.3";

const SIGNATURE_HEX_LENGTH: Partial<Record<TraceStateSignatureScheme, number>> = {
  "ed25519-v7.0": 128, // 64 bytes
} as const;

// ─── Hex / base64 shape regexes (validation-only, not crypto) ──────────────

const HEX_RE = /^[0-9a-fA-F]+$/;
const BASE64_RE = /^[A-Za-z0-9+/]+={0,2}$/;

// ─── Body shape ────────────────────────────────────────────────────────────

/**
 * Stripped-down trace step. Mirrors the v6 `StoredTrace` shape in
 * `src/graph/trace-store.ts` but excises everything that could leak a
 * URL path, query string, or response body. Only the decision_trace
 * step label + timing + status_class + (canonical, enumerated) error_code
 * survive the firmament.
 *
 * Coupling concern (Day-5 wiring decision): the v6 StoredTrace carries
 * `endpoint_sequence: string[]` (full endpoint_ids), `context_url`,
 * `goal_embedding`, and `params`. Day-5 CLI shim MUST strip these to the
 * v7 shape BEFORE POSTing — never pipe a v6 trace straight through.
 */
export interface StoredTraceStep {
  step: string;                                   // e.g. "server_fetch", "5xx_ssr_fastpath_fallback"
  duration_ms: number;
  status_class?: "2xx" | "3xx" | "4xx" | "5xx";   // canonical, NEVER the raw status code
  error_code?: string;                            // canonical enum, NOT free-form
}

export interface TraceAppendBody {
  walletPubkey: string;                           // 64-char hex
  signatureScheme?: TraceStateSignatureScheme;    // defaults to ed25519-v7.0
  signature: string;                              // 128-char hex (Ed25519)
  nonce: string;                                  // base64-encoded 32 bytes
  sessionId: string;                              // pointer back to SESSION_STATE row
  domain: string;                                 // host-only — no scheme, no path, no query
  traces: StoredTraceStep[];                      // decision_trace steps; pointer-only
}

export interface StoredTraceRow extends TraceAppendBody {
  received_at: number;                            // unix ms
  verify_ok: boolean;
  cacheKey: string;                               // sha256(sig)[:32]
}

// ─── Canonical JSON ────────────────────────────────────────────────────────

export function canonicalizeSignedFragment(body: TraceAppendBody): string {
  const tracesCanonical = body.traces.map((t) => ({
    step: t.step,
    duration_ms: t.duration_ms,
    status_class: t.status_class ?? null,
    error_code: t.error_code ?? null,
  }));
  return JSON.stringify({
    sessionId: body.sessionId,
    domain: body.domain,
    traces: tracesCanonical,
    nonce: body.nonce,
  });
}

export function canonicalizeFullBody(body: TraceAppendBody): string {
  return JSON.stringify({
    ...JSON.parse(canonicalizeSignedFragment(body)),
    walletPubkey: body.walletPubkey,
    signatureScheme: body.signatureScheme ?? "ed25519-v7.0",
    signature: body.signature,
  });
}

// ─── Cache-key derivation (Day-2 §G constraint #2) ─────────────────────────

/**
 * deriveCacheKey: sha256(signature)[:32]. The pointer-of-pointer that
 * uniquely names this trace-append row. Deterministic over the
 * signature — a second POST with the same body produces the same
 * cacheKey, idempotent at the KV layer.
 */
export async function deriveCacheKey(signature: Uint8Array): Promise<string> {
  return coreDeriveCacheKey(signature);
}

/** Convenience wrapper for the hex-encoded form. */
export async function deriveCacheKeyHex(signatureHex: string): Promise<string> {
  return deriveCacheKey(hexToBytes(signatureHex));
}

// ─── Schema validation ─────────────────────────────────────────────────────

export type ValidationError = CoreValidationError;

const TRACE_FORBIDDEN_REASON =
  "forbidden — trace-state carries decision_trace step labels + timings only (no cleartext, no URLs, no query strings)";

/**
 * Trace-specific no-cleartext gate. Delegates the field-match to the shared
 * `assertNoCleartext` (covenant-core) but stamps the trace-state reason so the
 * route's error message stays domain-specific. The covenant-core default
 * forbidden list is a superset of trace-state's historical list (value,
 * cleartext, secret, cookie, cookievalue, fillvalue, header, headervalue, url,
 * path, query, password, token, bearer, raw_body all included).
 */
function hasForbiddenField(body: Record<string, unknown>): ValidationError | null {
  const hit = assertNoCleartext(body);
  if (!hit) return null;
  return { field: hit.field, reason: TRACE_FORBIDDEN_REASON };
}

/**
 * Validate the domain field — must be host-only. Reject schemes, paths,
 * query strings, fragments, ports. The forensic invariant: a trace row
 * keyed by domain MUST aggregate cleanly across requests; embedding
 * `host:port` or `host/path` would shatter the per-domain rollup the
 * ranker depends on.
 */
function isValidHostOnly(domain: string): boolean {
  if (domain.length === 0 || domain.length > 253) return false;
  // No scheme.
  if (domain.includes("://")) return false;
  // No path/query/fragment.
  if (/[/?#]/.test(domain)) return false;
  // No port.
  if (domain.includes(":")) return false;
  // No userinfo.
  if (domain.includes("@")) return false;
  // No whitespace.
  if (/\s/.test(domain)) return false;
  // Must look like a hostname (letters/digits/dots/hyphens).
  if (!/^[a-z0-9.\-]+$/i.test(domain)) return false;
  return true;
}

export function validateTraceAppendBody(raw: unknown): ValidationError | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return { field: "$body", reason: "body must be a JSON object" };
  }
  const body = raw as Record<string, unknown>;

  // Forbidden-list gate.
  const forbidden = hasForbiddenField(body);
  if (forbidden) return forbidden;

  // Required string fields.
  for (const f of ["walletPubkey", "signature", "nonce", "sessionId", "domain"]) {
    const v = body[f];
    if (typeof v !== "string" || v.length === 0) {
      return { field: f, reason: "required string field missing or empty" };
    }
  }

  // Signature scheme.
  const rawScheme = body.signatureScheme;
  if (rawScheme !== undefined && rawScheme !== null) {
    if (typeof rawScheme !== "string") {
      return { field: "signatureScheme", reason: "must be a string when present" };
    }
    if (!(rawScheme in SIGNATURE_HEX_LENGTH)) {
      return { field: "signatureScheme", reason: `unsupported scheme '${rawScheme}'` };
    }
  }
  const scheme: TraceStateSignatureScheme = (rawScheme as TraceStateSignatureScheme | undefined) ?? "ed25519-v7.0";

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

  // Nonce — base64 32 bytes.
  const nonce = body.nonce as string;
  if (!BASE64_RE.test(nonce) || nonce.length < 43 || nonce.length > 44) {
    return { field: "nonce", reason: "must be base64-encoded 32 bytes (43-44 chars)" };
  }

  // sessionId — short string.
  const sessionId = body.sessionId as string;
  if (sessionId.length > 256) {
    return { field: "sessionId", reason: "must be <= 256 chars" };
  }

  // domain — host-only.
  const domain = body.domain as string;
  if (!isValidHostOnly(domain)) {
    return {
      field: "domain",
      reason: "must be host-only (no scheme, no path, no query, no port, no userinfo)",
    };
  }

  // traces — array of StoredTraceStep.
  if (!Array.isArray(body.traces)) {
    return { field: "traces", reason: "must be an array" };
  }
  if (body.traces.length > 1024) {
    return { field: "traces", reason: "must contain at most 1024 entries" };
  }
  for (let i = 0; i < body.traces.length; i++) {
    const t = body.traces[i] as Record<string, unknown>;
    if (!t || typeof t !== "object") {
      return { field: `traces[${i}]`, reason: "must be an object" };
    }
    // Forbidden-list applies inside each step — catches `url`, `path`,
    // `query`, `cookieValue` etc. that v6 traces carried.
    const innerForbidden = hasForbiddenField(t);
    if (innerForbidden) {
      return {
        field: `traces[${i}].${innerForbidden.field}`,
        reason: innerForbidden.reason,
      };
    }
    if (typeof t.step !== "string" || t.step.length === 0 || t.step.length > 128) {
      return { field: `traces[${i}].step`, reason: "must be a 1..128-char string" };
    }
    // Step name convention guard — lowercase + underscore + digits + colon-class only.
    // Matches CLAUDE.md "Decision-trace step naming convention".
    if (!/^[a-z0-9_]+$/.test(t.step)) {
      return {
        field: `traces[${i}].step`,
        reason: "must match lowercase decision-trace convention [a-z0-9_]+",
      };
    }
    if (typeof t.duration_ms !== "number" || !Number.isFinite(t.duration_ms) || t.duration_ms < 0) {
      return { field: `traces[${i}].duration_ms`, reason: "must be a non-negative finite number" };
    }
    if (t.status_class !== undefined && t.status_class !== null) {
      const sc = t.status_class;
      if (sc !== "2xx" && sc !== "3xx" && sc !== "4xx" && sc !== "5xx") {
        return {
          field: `traces[${i}].status_class`,
          reason: "must be one of 2xx | 3xx | 4xx | 5xx",
        };
      }
    }
    if (t.error_code !== undefined && t.error_code !== null) {
      if (typeof t.error_code !== "string" || t.error_code.length > 64) {
        return {
          field: `traces[${i}].error_code`,
          reason: "must be a <= 64 char canonical enum string",
        };
      }
    }
  }

  return null;
}

// ─── Ed25519 verification ──────────────────────────────────────────────────

export async function verifyTraceAppendSignature(body: TraceAppendBody): Promise<boolean> {
  const canonical = canonicalizeSignedFragment(body);
  const dataBytes = new TextEncoder().encode(canonical);
  return verifyEd25519(body.walletPubkey, body.signature, dataBytes);
}

// ─── KV key derivation ─────────────────────────────────────────────────────

export function traceKeyPrefix(walletPubkey: string): string {
  const wallet = walletPubkey.toLowerCase().replace(/^0x/, "");
  return `trace:${wallet}:`;
}

export function tracePrimaryKey(walletPubkey: string, cacheKey: string): string {
  return `${traceKeyPrefix(walletPubkey)}${cacheKey}`;
}

// ─── KV storage ────────────────────────────────────────────────────────────

export class BindingMissingError extends Error {
  readonly code = "trace_state_binding_missing";
  readonly namespace = "TRACE_STATE";
  constructor() {
    super(
      "env.TRACE_STATE is undefined — operator must run `bunx wrangler kv:namespace create TRACE_STATE` (and `--preview`), then paste the ids into backend/wrangler.toml.",
    );
    this.name = "BindingMissingError";
  }
}

function requireTraceState(env: Env): KVNamespace {
  if (!env.TRACE_STATE) throw new BindingMissingError();
  return env.TRACE_STATE;
}

// Rolling 7d TTL — per Day-2 §F decision.
const TRACE_TTL_SECONDS = 7 * 24 * 60 * 60;

/**
 * Persist a trace-append row. Idempotent on cacheKey = sha256(sig)[:32].
 * A second POST with the same body produces the same cacheKey and the
 * underlying KV row is detected + returned as `{idempotent: true}` with
 * no second write.
 */
export async function persistTraceRow(
  env: Env,
  body: TraceAppendBody,
  verifyOk: boolean,
  nowMs: number = Date.now(),
): Promise<{ cacheKey: string; primaryKey: string; idempotent: boolean }> {
  const kv = requireTraceState(env);
  const cacheKey = await deriveCacheKeyHex(body.signature);
  const primaryKey = tracePrimaryKey(body.walletPubkey, cacheKey);

  // Idempotency probe — same body → same cacheKey → same primaryKey.
  const existing = await kv.get(primaryKey);
  if (existing) {
    return { cacheKey, primaryKey, idempotent: true };
  }

  const storedRow: StoredTraceRow = {
    ...body,
    signatureScheme: body.signatureScheme ?? "ed25519-v7.0",
    received_at: nowMs,
    verify_ok: verifyOk,
    cacheKey,
  };

  await kv.put(primaryKey, JSON.stringify(storedRow), {
    expirationTtl: TRACE_TTL_SECONDS,
  });

  return { cacheKey, primaryKey, idempotent: false };
}

/**
 * Read one trace row by (walletPubkey, cacheKey). Wallet-prefix isolation
 * is the structural cross-wallet protection — wallet-A reading cacheKey X
 * resolves to `trace:<walletA>:X`, never to `trace:<walletB>:X`.
 */
export async function readTraceRow(
  env: Env,
  walletPubkey: string,
  cacheKey: string,
): Promise<StoredTraceRow | null> {
  const kv = requireTraceState(env);
  const key = tracePrimaryKey(walletPubkey, cacheKey);
  const raw = await kv.get(key);
  if (!raw) return null;
  try {
    return JSON.parse(raw) as StoredTraceRow;
  } catch {
    return null;
  }
}

/**
 * List trace rows for one wallet. Wallet-prefix scan; the KV layer
 * already enforces cross-wallet structural isolation, but the route
 * also re-checks each row's walletPubkey on read (defense-in-depth
 * per Day-2 §G constraint #5).
 */
export async function listTraceRowsByWallet(
  env: Env,
  walletPubkey: string,
  limit: number,
): Promise<StoredTraceRow[]> {
  const kv = requireTraceState(env);
  const prefix = traceKeyPrefix(walletPubkey);
  const listed = await kv.list({ prefix, limit });
  if (listed.keys.length === 0) return [];
  const values = await Promise.all(listed.keys.map((k) => kv.get(k.name)));
  const rows: StoredTraceRow[] = [];
  for (const v of values) {
    if (!v) continue;
    try {
      const parsed = JSON.parse(v) as StoredTraceRow;
      // Defense-in-depth — refuse to surface rows whose stored
      // walletPubkey diverges from the caller's wallet (Day-2 §G #5).
      const stored = parsed.walletPubkey?.toLowerCase().replace(/^0x/, "") ?? "";
      const caller = walletPubkey.toLowerCase().replace(/^0x/, "");
      if (stored !== caller) continue;
      rows.push(parsed);
    } catch {
      continue;
    }
  }
  return rows;
}
