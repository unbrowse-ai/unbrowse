/**
 * Audit-log routes — v7.0 sig-shape, REAL storage (W8 wave, 2026-05-28).
 *
 * Five endpoints, all under /v1/audit/*. The three POST routes share the
 * exact same body shape (AuditFillBody) so a future v7.3 SNARK swap
 * doesn't break the API — only the `signature` field's interpretation
 * widens. See .planning/v7-rip/ZK_SCOPE.md §"Verifier surface" and
 * §"v7.0 (sig-shape) → v7.x (SNARK)".
 *
 * What ships in v7.0 (post-W8):
 *   - Schema gate (validateAuditBody) — REAL; rejects cleartext-shaped
 *     bodies at the wire boundary.
 *   - Ed25519 signature verification — REAL; uses Web Crypto, same path
 *     as services/declare-signature.ts.
 *   - Deterministic receipt-id derivation — REAL; the CLI knows its own
 *     receipt id before the request lands (idempotency primitive).
 *   - KV storage — REAL; `env.AUDIT_LOG.put/get/list`. Two writes per
 *     POST (primary + pointer); idempotent on receiptId.
 *
 * Operator provisioning (one-time):
 *   bunx wrangler kv:namespace create AUDIT_LOG
 *   bunx wrangler kv:namespace create AUDIT_LOG --preview
 * Then paste the returned ids into wrangler.toml's AUDIT_LOG stanza. If
 * the binding is absent at request time, the route returns a 503 with
 * `{error: "audit_log_binding_missing"}` so the deployment-shape problem
 * surfaces honestly (1 Cor 14:8).
 *
 * Verify-only endpoint (/v1/audit/verify/:receiptId) re-derives the
 * Ed25519 signature server-side against the stored body (NEVER trusts
 * the stored `verify_ok` bit alone — that would only assert "valid at
 * write time", not "still valid in stored form"). Returns
 * `{receiptId, verify_ok, scheme}`. NEVER returns the pointer field per
 * W4 scope ("ok|fail without ever returning the pointer-value").
 *
 * Empty-state per CLAUDE.md "No stubs, no dummy data" rule: the GET-by-
 * wallet endpoint returns `{rows: [], limit}` (200, honest empty) when
 * the wallet has no rows. Never a placeholder.
 *
 * Heb 4:13 — "all things are naked and opened unto the eyes of him with
 * whom we have to do": every fill that crosses this surface is witnessed
 * as a sealed receipt before the Word.
 */

import { Hono, type Context } from "hono";
import type { Env } from "../types.js";
import {
  validateAuditBody,
  verifyAuditSignature,
  deriveReceiptId,
  persistAuditRow,
  listAuditRowsByWallet,
  readAuditRowByReceiptId,
  NotImplementedError,
  BindingMissingError,
  type AuditFillBody,
  type AuditVariant,
} from "../services/audit.js";
import {
  withCache,
  auditVerifyCacheKey,
  buildCacheHeaders,
  CacheNotModified,
  safeExecutionCtx,
} from "../services/kv-cache.js";

type AuditEnv = { Bindings: Env; Variables: Record<string, never> };

/**
 * Sentinel — thrown inside the cache compute when a receiptId resolves
 * to no stored row. Signaling via a typed exception instead of caching
 * a 404 payload prevents the cache from poisoning future legitimate
 * writes: a fresh POST that lands AFTER a 404 read MUST be reachable
 * by the verify endpoint on its next call. Matches the audit.ts
 * BindingMissingError shape (sibling discriminator pattern).
 */
class ReceiptNotFound extends Error {
  readonly code = "receipt_not_found";
  constructor(readonly receiptId: string) {
    super(`audit row ${receiptId} not found`);
    this.name = "ReceiptNotFound";
  }
}

export const auditRoutes = new Hono<AuditEnv>();

const DEFAULT_LIST_LIMIT = 100;
const MAX_LIST_LIMIT = 1000;

// ─── Admin auth (mirrors routes/admin.ts pattern) ──────────────────────────

function safeCompare(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) {
    diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return diff === 0;
}

function isAdmin(c: Context<AuditEnv>): boolean {
  const configured = c.env.ADMIN_KEY?.trim();
  if (!configured) return false;
  const header = c.req.header("Authorization");
  if (!header?.startsWith("Bearer ")) return false;
  const token = header.slice(7);
  return safeCompare(token, configured);
}

// ─── Shared POST handler — same body shape across all three variants ───────

async function handleAuditPost(c: Context<AuditEnv>, expectedVariant: AuditVariant) {
  let raw: unknown;
  try {
    raw = await c.req.json();
  } catch {
    return c.json({ error: "invalid_json", reason: "body must be JSON" }, 400);
  }

  // Schema gate.
  const validation = validateAuditBody(raw);
  if (validation) {
    return c.json(
      {
        error: "invalid_body",
        field: validation.field,
        reason: validation.reason,
      },
      400,
    );
  }

  const body = raw as AuditFillBody;

  // Variant must match the route mounted. Deut 19:15 — two witnesses:
  // the URL path AND the body.variant tag must agree, or the receipt is
  // ambiguous about which variant it witnessed. Reject so the forensic
  // trail stays unambiguous.
  if (body.variant !== expectedVariant) {
    return c.json(
      {
        error: "route_body_variant_mismatch",
        expected: expectedVariant,
        got: body.variant,
      },
      400,
    );
  }

  // Variant-specific required correlation fields are now enforced inside
  // validateAuditBody (W12 wave, 2026-05-28) — each variant carries its
  // own required locator + mutually-exclusive forbidden siblings. Deut
  // 19:15 — each variant is a distinct witness. The schema gate above
  // already 400'd on missing/wrong locator; no soft-warning path remains.
  const warnings: string[] = [];

  // Deterministic receipt id — caller can predict this.
  const receiptId = await deriveReceiptId(body);

  // REAL Ed25519 verify (v7.0). The result lands in the stored row even
  // when verify_ok=false so the audit trail records the attempt
  // (forensic value).
  const verifyOk = await verifyAuditSignature(body);

  // KV write path — REAL (W8). Two writes per POST (primary + pointer),
  // idempotent on receiptId. A second POST with the same body returns
  // `idempotent: true` and the SAME receiptId — no second write hits KV.
  try {
    const { idempotent } = await persistAuditRow(c.env, body, verifyOk);
    return c.json({
      ok: true,
      receiptId,
      verify_ok: verifyOk,
      idempotent,
      warnings,
    });
  } catch (err) {
    if (err instanceof BindingMissingError) {
      return c.json(
        {
          error: "audit_log_binding_missing",
          reason:
            "operator must run `bunx wrangler kv:namespace create AUDIT_LOG` and paste the id into wrangler.toml",
          receiptId,
          verify_ok: verifyOk,
        },
        503,
      );
    }
    if (err instanceof NotImplementedError) {
      // Reachable only if a future v7.x extension hits a not-yet-wired
      // SNARK path. v7.0 storage is real; keep the catch arm so the
      // forward-compat surface stays honest.
      return c.json(
        {
          error: "not_implemented_yet",
          receiptId,
          verify_ok: verifyOk,
          warnings,
          _wave_hint: err.waveHint,
          _kv_key_intent: err.kvKey,
        },
        501,
      );
    }
    throw err;
  }
}

// ─── POST routes — three variants, one body shape ──────────────────────────

auditRoutes.post("/v1/audit/fill", (c) => handleAuditPost(c, "fill"));
auditRoutes.post("/v1/audit/header-inject", (c) => handleAuditPost(c, "header-inject"));
auditRoutes.post("/v1/audit/payload-field", (c) => handleAuditPost(c, "payload-field"));

// ─── GET /v1/audit/by-wallet/:walletPubkey (admin-gated) ───────────────────

auditRoutes.get("/v1/audit/by-wallet/:walletPubkey", async (c) => {
  if (!isAdmin(c)) {
    return c.json({ error: "unauthorized" }, 401);
  }

  const walletPubkey = c.req.param("walletPubkey");
  const walletClean = walletPubkey.toLowerCase().replace(/^0x/, "");
  if (walletClean.length !== 64 || !/^[0-9a-f]+$/.test(walletClean)) {
    return c.json({ error: "invalid_wallet_pubkey", reason: "must be 32-byte hex" }, 400);
  }

  const limitRaw = c.req.query("limit");
  let limit = DEFAULT_LIST_LIMIT;
  if (limitRaw) {
    const parsed = Number.parseInt(limitRaw, 10);
    if (!Number.isFinite(parsed) || parsed <= 0) {
      return c.json({ error: "invalid_limit", reason: "must be positive integer" }, 400);
    }
    limit = Math.min(parsed, MAX_LIST_LIMIT);
  }

  try {
    const rows = await listAuditRowsByWallet(c.env, walletPubkey, limit);
    // Honest empty-state per CLAUDE.md "No stubs, no dummy data":
    // when the wallet has no rows, return [], not a placeholder.
    return c.json({ rows, limit });
  } catch (err) {
    if (err instanceof BindingMissingError) {
      return c.json(
        {
          error: "audit_log_binding_missing",
          reason:
            "operator must run `bunx wrangler kv:namespace create AUDIT_LOG` and paste the id into wrangler.toml",
          rows: [],
          limit,
        },
        503,
      );
    }
    if (err instanceof NotImplementedError) {
      return c.json(
        {
          error: "not_implemented_yet",
          _wave_hint: err.waveHint,
          _kv_key_intent: err.kvKey,
          rows: [],
          limit,
        },
        501,
      );
    }
    throw err;
  }
});

// ─── GET /v1/audit/verify/:receiptId (public; ok|fail only) ────────────────
//
// Returns 200 with {receiptId, verify_ok} when the row exists. NEVER
// returns the pointer-value (the W4 spec is explicit: "verify a single
// audit row's signature; returns ok|fail without ever returning the
// pointer-value"). The pointer field IS an addressable reference and
// would technically be safe to return, but the contract is conservative
// — only the boolean leaks at this endpoint.

auditRoutes.get("/v1/audit/verify/:receiptId", async (c) => {
  const receiptId = c.req.param("receiptId");
  if (!/^[0-9a-fA-F]{64}$/.test(receiptId)) {
    return c.json({ error: "invalid_receipt_id", reason: "must be sha256 hex (64 chars)" }, 400);
  }

  try {
    // W17: response-cache wrap. The audit row is IMMUTABLE post-write
    // (receipt id is sha256(canonical body)), so a 24h TTL is safe — the
    // body cannot change for a given receiptId, only disappear (KV
    // expiry, manual delete). The cached payload carries ONLY
    // {verify_ok, scheme} — NEVER the pointer, NEVER the body. Matches
    // the W4 spec ("ok|fail without ever returning the pointer-value")
    // verbatim. Matt 6:34 — sufficient unto the day. Heb 6:18 — the
    // etag is the immutable witness.
    //
    // SECURITY: under no circumstance does the audit row body, pointer,
    // selectorHash, headerNameHash, signature, or walletPubkey enter
    // the cached value. Only the {verify_ok, scheme} pair. Bypass
    // honored via Cache-Control: no-cache for forensic re-checks.
    const noCacheHdr = c.req.header("cache-control")?.toLowerCase().includes("no-cache") ?? false;
    const ifNoneMatch = c.req.header("if-none-match")?.replace(/^"|"$/g, "") ?? undefined;

    type VerifyPayload = { verify_ok: boolean; scheme: string };
    let cacheResult;
    try {
      cacheResult = await withCache<VerifyPayload>(
        c.env,
        auditVerifyCacheKey(receiptId),
        86400, // 24h — audit rows are immutable; receiptId is sha256(canonical body).
        {
          bypass: noCacheHdr,
          staleWhileRevalidate: false, // Verify is deterministic; SWR would only hide stale-bytes corruption from re-verify.
          ctx: safeExecutionCtx(c),
          honorIfNoneMatch: ifNoneMatch,
        },
        async () => {
          const row = await readAuditRowByReceiptId(c.env, receiptId);
          if (!row) {
            // Sentinel — mapped to 404 below. Throwing here would
            // poison the cache for the (legitimate) "row truly does
            // not exist yet" case; signaling via a sentinel keeps
            // 404s OUT of the cache.
            throw new ReceiptNotFound(receiptId);
          }
          // Re-verify server-side. NEVER trust stored verify_ok bit
          // alone — the re-derive catches KV corruption.
          const verifyOk = await verifyAuditSignature(row);
          const scheme = row.signatureScheme ?? "ed25519-v7.0";
          // Hard scope: ONLY these two fields enter the cache. The
          // pointer, selectorHash, body, signature stay in KV under
          // AUDIT_LOG — never in RESPONSE_CACHE.
          return { verify_ok: verifyOk, scheme };
        },
      );
    } catch (cacheErr) {
      if (cacheErr instanceof CacheNotModified) {
        // If-None-Match matched. 304 Not Modified, no body.
        c.header("ETag", `"${cacheErr.etag}"`);
        c.header("X-Cache", "HIT");
        return c.body(null, 304);
      }
      if (cacheErr instanceof ReceiptNotFound) {
        return c.json({ error: "receipt_not_found", receiptId }, 404);
      }
      throw cacheErr;
    }

    const headers = buildCacheHeaders(cacheResult);
    for (const [k, v] of Object.entries(headers)) c.header(k, v);
    return c.json({ receiptId, ...cacheResult.value });
  } catch (err) {
    if (err instanceof BindingMissingError) {
      return c.json(
        {
          error: "audit_log_binding_missing",
          reason:
            "operator must run `bunx wrangler kv:namespace create AUDIT_LOG` and paste the id into wrangler.toml",
          receiptId,
        },
        503,
      );
    }
    if (err instanceof NotImplementedError) {
      return c.json(
        {
          error: "not_implemented_yet",
          receiptId,
          _wave_hint: err.waveHint,
          _kv_key_intent: err.kvKey,
        },
        501,
      );
    }
    throw err;
  }
});
