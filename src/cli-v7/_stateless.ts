/**
 * CLI-side stateless adapter — the LUMINARY. Day-4 worker B deliverable, 2026-05-28.
 *
 * Every CLI primitive that crosses the boundary routes through
 * `postStateless(...)` (W24.6: stateless is the sole path). The adapter:
 *   1. Generates a fresh 32-byte base64 nonce (unless body already carries one).
 *   2. Canonicalizes a whitelisted signed fragment per-namespace.
 *   3. Signs it with the x402 wallet (`signBytes` → 64-byte Ed25519 sig).
 *   4. Derives `cacheKey = sha256(sig).slice(0, 32)` — byte-identical to
 *      backend's `deriveCacheKey` (services/stateless-platform.ts §215).
 *   5. POSTs the full body (original fields + walletPubkey + signature +
 *      signatureScheme + nonce) to the namespace's wallet-bound route.
 *   6. Returns a `PostStatelessResult` with cacheKey, idempotency flag,
 *      http status, and optional `bindingMissing` envelope (NEVER throws
 *      on network/binding errors — surfaces the failure shape).
 *
 * Doctrine:
 *   - Pointer-not-payload (contract 3c2dd353): the adapter NEVER logs
 *     cleartext, NEVER logs the signature, and NEVER dereferences
 *     pointer URIs (pointer URIs themselves are log-safe per W4).
 *   - platform enables; it never prescribes (contract ee1f5409). The
 *     adapter is a pure utility — it does not choose WHICH namespace a
 *     primitive routes to. Handlers (Day-6 Dominion) make that call.
 *   - No new top-level deps. Bun + Web Crypto + node:crypto only.
 *   - The signature buffer is zeroed via `safeZero` on every exit path
 *     (W6 invariant carried forward to every cross-boundary POST).
 *
 * RESPONSE_CACHE is explicitly NOT a CLI-writable namespace; backend
 * derives it from origin responses. Hence `StatelessNamespaceName`
 * omits it.
 *
 *  — *"all things are naked and opened unto the eyes of him."*
 * The receipt is the witness; every act is sig-keyed and visible.
 */

import { randomBytes, createHash } from "node:crypto";

import { signBytes } from "../values/signer.js";
import { safeZero } from "../values/memzero.js";
import { DEFAULT_BACKEND_URL } from "../version.js";

// ─── Public types ──────────────────────────────────────────────────────────

export type StatelessNamespaceName =
  | "audit"
  | "session"
  | "trace"
  | "settings"
  | "screenshot";

export interface PostStatelessInput<TBody extends Record<string, unknown>> {
  /** Namespace label — informational; the route is the authoritative target. */
  readonly namespace: StatelessNamespaceName;
  /** Backend route path, e.g. "/v1/trace/append". Leading slash required. */
  readonly route: string;
  /**
   * Body fields the caller already populated. The adapter MUTATES NOTHING;
   * it builds a NEW object that extends body with {walletPubkey, signature,
   * signatureScheme, nonce}. If body already carries `nonce`, the adapter
   * reuses it (idempotent re-post case).
   */
  readonly body: TBody;
  /**
   * Field names from body+nonce that get included in the signed fragment.
   * The adapter canonicalizes ONLY these fields (lex-sorted key order) and
   * passes the resulting bytes to `signBytes`. Backend MUST canonicalize
   * the same whitelist or the sig won't verify.
   */
  readonly signableFields: readonly string[];
  /** Override the backend URL. Defaults to env UNBROWSE_API_URL || DEFAULT_BACKEND_URL. */
  readonly apiBaseUrl?: string;
  /**
   * Optional fetch implementation (test injection). Defaults to globalThis.fetch.
   * Signature mirrors the standard fetch — receives the constructed URL + init.
   */
  readonly fetchImpl?: typeof fetch;
}

export interface PostStatelessResult {
  /** True iff the backend returned 2xx and `_binding_missing` was absent. */
  readonly ok: boolean;
  /** sha256(signature).slice(0, 32) hex — byte-identical to backend derivation. */
  readonly cacheKey: string;
  /** Backend's receipt id (audit row id / trace row id), when supplied. */
  readonly receiptId?: string;
  /** True iff the backend reported the row already existed (re-post). */
  readonly idempotent: boolean;
  /** HTTP status from the POST. `0` on network error / fetch throw. */
  readonly httpStatus: number;
  /** Namespace name from `{_binding_missing}` envelope, if backend returned 503. */
  readonly bindingMissing?: string;
  /** Sanitized error description (NEVER body/sig/cleartext). */
  readonly errorHint?: string;
}

export const STATELESS_SIGNATURE_SCHEME = "ed25519-v7.0" as const;

// ─── Helpers ───────────────────────────────────────────────────────────────

function bytesToHex(b: Uint8Array): string {
  let h = "";
  for (let i = 0; i < b.length; i++) h += b[i].toString(16).padStart(2, "0");
  return h;
}

function bytesToBase64(b: Uint8Array): string {
  return Buffer.from(b).toString("base64");
}

/**
 * Build the canonical-JSON signed fragment for a body whitelist. Key order
 * is the order of `fields` as provided — backend MUST agree on the same
 * order; we do NOT lex-sort because the backend's per-namespace canonical
 * (e.g. audit.ts `canonicalizeSignedFragment`) is order-explicit.
 *
 * Behavior:
 *   - Missing fields are coerced to `null` (matches audit.ts pattern for
 *     optionals).
 *   - Forbidden top-level fields (`value`, `cleartext`, `secret`, …) get
 *     REJECTED at this layer with a throw. This is defense-in-depth — the
 *     backend's `checkForbiddenFields` is the canonical witness; this
 *     stops a cleartext leak before it touches the network at all.
 */
const FORBIDDEN_FIELDS_LC = new Set([
  "value", "cleartext", "secret",
  "cookie", "cookievalue", "cookievalues",
  "fillvalue",
  "header", "headervalue", "headername",
  "password", "token", "bearer",
  // NOTE: backend also forbids "url|path|query|selector" in stateless bodies,
  // but those are sometimes legitimate fields on legacy AUDIT_LOG bodies (e.g.
  // urlHash is a hash, not a URL). The adapter delegates final forbidden-
  // field judgment to the backend; this top-level set covers only the
  // unambiguous cleartext-leak field names.
]);

export function canonicalizeSignedFragment(
  body: Record<string, unknown>,
  fields: readonly string[],
): string {
  const fragment: Record<string, unknown> = {};
  for (const f of fields) {
    if (FORBIDDEN_FIELDS_LC.has(f.toLowerCase())) {
      throw new Error(
        `canonicalizeSignedFragment: forbidden field "${f}" — stateless ` +
          `platform carries pointers/hashes only`,
      );
    }
    const v = body[f];
    fragment[f] = v === undefined ? null : v;
  }
  return JSON.stringify(fragment);
}

/** 32 random bytes, base64-encoded. 44 chars (with padding). */
export function freshNonce(): string {
  return bytesToBase64(new Uint8Array(randomBytes(32)));
}

/**
 * sha256(signature).slice(0, 32) hex. MUST be byte-identical to backend's
 * `deriveCacheKey` in `services/stateless-platform.ts`. the root signature-system
 * parity test in `tests/v7-cli-stateless-signer.test.ts` is the witness.
 *
 * Async because Web Crypto's `digest` returns a Promise; we use node's
 * `createHash` to stay synchronous-friendly under Bun + Node, then return
 * the result wrapped in a resolved Promise so the surface is uniform.
 */
export async function deriveCacheKeyFromSignature(
  signature: Uint8Array,
): Promise<string> {
  const hashHex = createHash("sha256").update(signature).digest("hex");
  return hashHex.slice(0, 32);
}

// ─── Logging — pointer-only, signature-redacted ────────────────────────────

/**
 * Redact a single error message so cleartext / signatures / pointer values
 * cannot leak through to stderr. Returns a sanitized short string.
 */
function sanitizeErrorHint(err: unknown): string {
  let msg: string;
  if (err instanceof Error) msg = err.message;
  else if (typeof err === "string") msg = err;
  else {
    try { msg = JSON.stringify(err); } catch { msg = String(err); }
  }
  // Strip anything that looks like a hex signature (>= 64 hex chars).
  msg = msg.replace(/\b[0-9a-fA-F]{64,}\b/g, "<hex-redacted>");
  // Strip anything that looks like a base64 secret (>= 40 base64 chars
  // ending in `=` or `==`).
  msg = msg.replace(/\b[A-Za-z0-9+/]{40,}={0,2}\b/g, "<b64-redacted>");
  // Cap length.
  return msg.slice(0, 200);
}

// ─── Backend URL resolution ────────────────────────────────────────────────

function resolveApiBase(override?: string): string {
  const fromEnv = process.env.UNBROWSE_API_URL;
  const raw = override ?? fromEnv ?? DEFAULT_BACKEND_URL;
  return raw.replace(/\/$/, "");
}

// ─── The adapter ───────────────────────────────────────────────────────────

/**
 * Sign + POST a stateless body to its wallet-bound route. The single
 * route-emission surface on the CLI side (Day-4 boundary).
 *
 * Behavior:
 *   - On 2xx: `{ok: true, cacheKey, idempotent, httpStatus, receiptId?}`.
 *     `idempotent` reflects the backend's `idempotent: true` flag in the
 *     response body (audit + session services both set this).
 *   - On 503 with `{_binding_missing: "NAME"}`: `{ok: false, cacheKey,
 *     bindingMissing: "NAME", httpStatus: 503}`. NOT a throw — graceful
 *     degraded mode the caller decides how to handle (typically fall
 *     through to `~/.unbrowse/` legacy path under v6 escape).
 *   - On 4xx / non-503 5xx: `{ok: false, cacheKey, httpStatus, errorHint}`.
 *   - On fetch throw / network error: `{ok: false, cacheKey, httpStatus: 0,
 *     errorHint}`. NEVER re-throws.
 *
 * The `cacheKey` is computed locally BEFORE the POST, so it is returned
 * even on failure paths — every caller has a stable pointer to the
 * truth-claim they tried to seal, regardless of whether the seal landed.
 */
export async function postStateless<TBody extends Record<string, unknown>>(
  input: PostStatelessInput<TBody>,
): Promise<PostStatelessResult> {
  // 1. Nonce — reuse if body already carries one, else freshen.
  const nonceFromBody = typeof input.body["nonce"] === "string"
    ? (input.body["nonce"] as string)
    : undefined;
  const nonce = nonceFromBody ?? freshNonce();

  // 2. Build the body-with-nonce that the signed fragment is canonicalized over.
  //    `signableFields` controls WHICH fields land in the fragment; the full
  //    body sent on the wire is `body ∪ {walletPubkey, signature, signatureScheme, nonce}`.
  const bodyWithNonce: Record<string, unknown> = {
    ...input.body,
    nonce,
  };

  // 3. Canonicalize the signed fragment (per-namespace whitelist).
  let canonical: string;
  try {
    canonical = canonicalizeSignedFragment(bodyWithNonce, input.signableFields);
  } catch (err) {
    return {
      ok: false,
      cacheKey: "",
      idempotent: false,
      httpStatus: 0,
      errorHint: sanitizeErrorHint(err),
    };
  }
  const canonicalBytes = new TextEncoder().encode(canonical);

  // 4. Sign — Ed25519 over the canonical fragment bytes.
  let signature: Uint8Array;
  let walletPubkey: Uint8Array;
  try {
    const signed = await signBytes(canonicalBytes);
    signature = signed.signature;
    walletPubkey = signed.walletPubkey;
  } catch (err) {
    return {
      ok: false,
      cacheKey: "",
      idempotent: false,
      httpStatus: 0,
      errorHint: sanitizeErrorHint(err),
    };
  }

  // 5. Derive cacheKey from the signature — byte-identical to backend.
  const cacheKey = await deriveCacheKeyFromSignature(signature);

  // 6. Construct full wire body. Hex-encode sig + wallet; keep nonce as
  //    base64. signatureScheme defaults to the v7.0 constant; callers
  //    that need v7.2 schema (e.g. session-park) override post-construction
  //    by passing the override in `body.signatureScheme` BEFORE calling.
  const signatureHex = bytesToHex(signature);
  const walletPubkeyHex = bytesToHex(walletPubkey);
  const wireBody: Record<string, unknown> = {
    ...bodyWithNonce,
    walletPubkey: walletPubkeyHex,
    signatureScheme: bodyWithNonce["signatureScheme"] ?? STATELESS_SIGNATURE_SCHEME,
    signature: signatureHex,
  };

  // 7. POST.
  const apiBase = resolveApiBase(input.apiBaseUrl);
  const url = `${apiBase}${input.route.startsWith("/") ? "" : "/"}${input.route}`;
  const doFetch = input.fetchImpl ?? globalThis.fetch;

  let httpStatus = 0;
  let parsedAck: Record<string, unknown> = {};
  try {
    const res = await doFetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(wireBody),
    });
    httpStatus = res.status;
    try {
      parsedAck = (await res.json()) as Record<string, unknown>;
    } catch {
      parsedAck = {};
    }
  } catch (err) {
    // Zero sig buffer before returning on any exit path.
    safeZero(signature);
    return {
      ok: false,
      cacheKey,
      idempotent: false,
      httpStatus: 0,
      errorHint: sanitizeErrorHint(err),
    };
  } finally {
    // Defense-in-depth: zero sig on the happy path too (the hex form lives
    // on but the raw bytes do not). Idempotent — safe to call after the
    // catch already ran.
    safeZero(signature);
  }

  // 8. Parse response shape.
  if (httpStatus === 503 && typeof parsedAck["_binding_missing"] === "string") {
    return {
      ok: false,
      cacheKey,
      idempotent: false,
      httpStatus,
      bindingMissing: parsedAck["_binding_missing"] as string,
    };
  }

  if (httpStatus >= 200 && httpStatus < 300) {
    const idempotent = parsedAck["idempotent"] === true;
    const receiptId = typeof parsedAck["receiptId"] === "string"
      ? (parsedAck["receiptId"] as string)
      : undefined;
    return {
      ok: true,
      cacheKey,
      idempotent,
      httpStatus,
      receiptId,
    };
  }

  // 4xx or non-503 5xx — surface as failure with sanitized hint.
  const ackError = typeof parsedAck["error"] === "string"
    ? (parsedAck["error"] as string)
    : typeof parsedAck["reason"] === "string"
      ? (parsedAck["reason"] as string)
      : `http_${httpStatus}`;
  return {
    ok: false,
    cacheKey,
    idempotent: false,
    httpStatus,
    errorHint: sanitizeErrorHint(ackError),
  };
}

// ─── Diagnostics-only exports (NOT general-use) ────────────────────────────

/**
 * Test-only handle to internals. Day-6 handlers MUST use `postStateless` +
 * the public helpers; tests need the inner pieces for byte-parity checks.
 */
export const __internal = {
  bytesToHex,
  bytesToBase64,
  sanitizeErrorHint,
  resolveApiBase,
  FORBIDDEN_FIELDS_LC,
};
