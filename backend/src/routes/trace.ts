/**
 * Trace-state routes — v7.2.0-preview.0 (Day-3 Land worker B, 2026-05-28).
 *
 * Three endpoints under /v1/trace/*. All are wallet-signed; the wallet
 * pubkey + KV key prefix enforces cross-wallet isolation (Day-2 §H #2).
 *
 *   POST /v1/trace/append              — body: wallet-signed TraceAppendBody
 *   GET  /v1/trace/by-receipt/:cacheKey — wallet-signed challenge headers
 *   GET  /v1/trace/by-wallet           — ADMIN_KEY-gated list (mirrors
 *                                        the audit /by-wallet route)
 *
 * Dan 7:10 — "the books were opened": traces are the books, sig-keyed
 * so each wallet's books are bound to its own steward.
 *
 * Coupling concern (Day-5 wiring): the v6 `StoredTrace` shape in
 * `src/graph/trace-store.ts` carries url-shaped fields (`endpoint_sequence`,
 * `context_url`) that are FORBIDDEN by this route. Day-5 CLI shim must
 * strip those before POSTing.
 */

import { Hono, type Context } from "hono";
import type { Env } from "../types.js";
import {
  validateTraceAppendBody,
  verifyTraceAppendSignature,
  persistTraceRow,
  readTraceRow,
  listTraceRowsByWallet,
  deriveCacheKeyHex,
  BindingMissingError,
  type TraceAppendBody,
} from "../services/trace-state.js";

type TraceEnv = { Bindings: Env; Variables: Record<string, never> };

export const traceRoutes = new Hono<TraceEnv>();

const HEX_RE = /^[0-9a-fA-F]+$/;
const CHALLENGE_WINDOW_MS = 60_000;
const DEFAULT_LIST_LIMIT = 100;
const MAX_LIST_LIMIT = 1000;

// ─── Admin auth (mirrors routes/admin.ts + routes/audit.ts pattern) ────────

function safeCompare(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) {
    diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return diff === 0;
}

function isAdmin(c: Context<TraceEnv>): boolean {
  const configured = c.env.ADMIN_KEY?.trim();
  if (!configured) return false;
  const header = c.req.header("Authorization");
  if (!header?.startsWith("Bearer ")) return false;
  const token = header.slice(7);
  return safeCompare(token, configured);
}

// ─── POST /v1/trace/append ─────────────────────────────────────────────────

traceRoutes.post("/v1/trace/append", async (c: Context<TraceEnv>) => {
  let raw: unknown;
  try {
    raw = await c.req.json();
  } catch {
    return c.json({ error: "invalid_json", reason: "body must be JSON" }, 400);
  }

  const validation = validateTraceAppendBody(raw);
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
  const body = raw as TraceAppendBody;

  const verifyOk = await verifyTraceAppendSignature(body);
  if (!verifyOk) {
    return c.json(
      {
        error: "signature_invalid",
        reason: "Ed25519 verify failed against canonical signed-fragment",
      },
      401,
    );
  }

  const cacheKey = await deriveCacheKeyHex(body.signature);

  try {
    const { idempotent, primaryKey } = await persistTraceRow(c.env, body, verifyOk);
    return c.json({
      ok: true,
      cacheKey,
      verify_ok: verifyOk,
      idempotent,
      primaryKey,
      _binding_status: "wired",
    });
  } catch (err) {
    if (err instanceof BindingMissingError) {
      return c.json(
        {
          error: "trace_state_binding_missing",
          _binding_missing: "TRACE_STATE",
          cacheKey,
          verify_ok: verifyOk,
          _wave_hint:
            "operator must run `bunx wrangler kv:namespace create TRACE_STATE` (and --preview), then paste the ids into backend/wrangler.toml.",
        },
        503,
      );
    }
    throw err;
  }
});

// ─── GET /v1/trace/by-receipt/:cacheKey ────────────────────────────────────

traceRoutes.get("/v1/trace/by-receipt/:cacheKey", async (c: Context<TraceEnv>) => {
  const cacheKey = c.req.param("cacheKey");
  if (!cacheKey || cacheKey.length !== 32 || !HEX_RE.test(cacheKey)) {
    return c.json({ error: "invalid_cache_key", reason: "must be 32 hex chars" }, 400);
  }

  // Wallet-sig challenge headers (mirrors session-state restore).
  const authHeader = c.req.header("Authorization") ?? "";
  if (!authHeader.toLowerCase().startsWith("walletsig ")) {
    return c.json(
      {
        error: "unauthorized",
        reason: "Authorization header must be 'WalletSig <hex>'",
      },
      401,
    );
  }
  const sigHex = authHeader.slice("walletsig ".length).trim();
  if (sigHex.length === 0 || !HEX_RE.test(sigHex)) {
    return c.json({ error: "unauthorized", reason: "WalletSig must be hex" }, 401);
  }

  const pubHex = c.req.header("X-Wallet-Pubkey") ?? "";
  const pubClean = pubHex.startsWith("0x") ? pubHex.slice(2) : pubHex;
  if (pubClean.length !== 64 || !HEX_RE.test(pubClean)) {
    return c.json(
      {
        error: "unauthorized",
        reason: "X-Wallet-Pubkey must be 32-byte hex (64 chars)",
      },
      401,
    );
  }

  const tsHeader = c.req.header("X-Wallet-Timestamp") ?? "";
  const tsMs = Number.parseInt(tsHeader, 10);
  if (!Number.isFinite(tsMs)) {
    return c.json({ error: "unauthorized", reason: "X-Wallet-Timestamp must be unix-ms" }, 401);
  }
  if (Math.abs(Date.now() - tsMs) > CHALLENGE_WINDOW_MS) {
    return c.json({ error: "unauthorized", reason: "timestamp drift exceeds window" }, 401);
  }

  // Verify the challenge sig over `<cacheKey> || ":" || <ts>`.
  try {
    const pubBytes = new Uint8Array(
      pubClean.match(/.{2}/g)!.map((h) => parseInt(h, 16)),
    );
    const sigBytes = new Uint8Array(
      sigHex.match(/.{2}/g)!.map((h) => parseInt(h, 16)),
    );
    if (pubBytes.length !== 32 || sigBytes.length !== 64) {
      return c.json({ error: "unauthorized", reason: "malformed key/sig length" }, 401);
    }
    const message = `${cacheKey}:${tsMs}`;
    const messageBytes = new TextEncoder().encode(message);
    const key = await crypto.subtle.importKey(
      "raw",
      pubBytes,
      { name: "Ed25519" },
      false,
      ["verify"],
    );
    const ok = await crypto.subtle.verify({ name: "Ed25519" }, key, sigBytes, messageBytes);
    if (!ok) {
      return c.json(
        {
          error: "unauthorized",
          reason: "WalletSig did not verify over (cacheKey || ':' || timestamp)",
        },
        401,
      );
    }
  } catch {
    return c.json({ error: "unauthorized", reason: "challenge verify threw" }, 401);
  }

  try {
    const row = await readTraceRow(c.env, pubClean, cacheKey);
    if (!row) {
      return c.json({ error: "trace_not_found", cacheKey }, 404);
    }
    // Defense-in-depth wallet check (Day-2 §G #5).
    if (row.walletPubkey.toLowerCase().replace(/^0x/, "") !== pubClean) {
      return c.json(
        {
          error: "wallet_mismatch",
          reason:
            "stored row's walletPubkey does not match the requesting wallet — KV row may be corrupted",
        },
        403,
      );
    }
    return c.json({ ok: true, cacheKey, row, _binding_status: "wired" });
  } catch (err) {
    if (err instanceof BindingMissingError) {
      return c.json(
        {
          error: "trace_state_binding_missing",
          _binding_missing: "TRACE_STATE",
          cacheKey,
          _wave_hint:
            "operator must run `bunx wrangler kv:namespace create TRACE_STATE` (and --preview), then paste the ids into backend/wrangler.toml.",
        },
        503,
      );
    }
    throw err;
  }
});

// ─── GET /v1/trace/by-wallet (admin-gated) ─────────────────────────────────

traceRoutes.get("/v1/trace/by-wallet", async (c: Context<TraceEnv>) => {
  if (!isAdmin(c)) {
    return c.json({ error: "unauthorized" }, 401);
  }
  const walletPubkey = c.req.query("wallet");
  if (!walletPubkey) {
    return c.json({ error: "missing_wallet", reason: "?wallet=<hex> required" }, 400);
  }
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
    const rows = await listTraceRowsByWallet(c.env, walletPubkey, limit);
    return c.json({ rows, limit });
  } catch (err) {
    if (err instanceof BindingMissingError) {
      return c.json(
        {
          error: "trace_state_binding_missing",
          _binding_missing: "TRACE_STATE",
          rows: [],
          limit,
        },
        503,
      );
    }
    throw err;
  }
});
