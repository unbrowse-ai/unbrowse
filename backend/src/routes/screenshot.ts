/**
 * Screenshot-blob routes — v7.2.0-preview.0 Day-5 SWARM worker D, 2026-05-28.
 *
 * Two endpoints under /v1/screenshot/*:
 *
 *   POST /v1/screenshot/store
 *     Body: JSON ScreenshotStoreBody (includes base64 blob field).
 *     Decision: JSON-with-base64 over multipart — the existing
 *     `postStateless(...)` adapter assumes content-type application/json
 *     so a multipart variant would fork the wire surface for one
 *     namespace. The blob is bounded at 8MB; base64 grows by 4/3 → cap
 *     wire body at ~11MB, well under Cloudflare Worker request limits.
 *     The signature is over `{sessionId, urlHash, blobSha256, capturedAt,
 *     nonce}` — blobBase64 is NOT in the signed fragment; `blobSha256`
 *     binds the bytes transitively.
 *
 *   GET /v1/screenshot/by-sigkey/:sigKey
 *     Wallet-signed challenge (Authorization: WalletSig <hex>,
 *     X-Wallet-Pubkey, X-Wallet-Timestamp). Returns the raw PNG bytes
 *     when found, 404 when not, 503 when binding absent.
 *
 * Inert-fallback: when env.SCREENSHOT_BLOB is undefined, both routes
 * return 503 with `{_binding_missing: "SCREENSHOT_BLOB"}` — the
 * CLI handler treats this as graceful-degrade and writes to
 * `~/.unbrowse/tmp/<sigKey>/screenshot.png` (Day-4 A5 lost-sheep rule).
 *
 * Heb 4:13 — *"all things are naked and opened unto the eyes of him."*
 */

import { Hono, type Context } from "hono";
import type { Env } from "../types.js";
import {
  validateScreenshotStoreBody,
  verifyScreenshotStoreSignature,
  persistScreenshotRow,
  readScreenshotMeta,
  readScreenshotBlob,
  deriveSigKeyHex,
  sha256Hex,
  BindingMissingError,
  type ScreenshotStoreBody,
} from "../services/screenshot-blob.js";

type ScreenshotEnv = { Bindings: Env; Variables: Record<string, never> };

export const screenshotRoutes = new Hono<ScreenshotEnv>();

const HEX_RE = /^[0-9a-fA-F]+$/;
const CHALLENGE_WINDOW_MS = 60_000;

// ─── POST /v1/screenshot/store ─────────────────────────────────────────────

screenshotRoutes.post("/v1/screenshot/store", async (c: Context<ScreenshotEnv>) => {
  let raw: unknown;
  try {
    raw = await c.req.json();
  } catch {
    return c.json({ error: "invalid_json", reason: "body must be JSON" }, 400);
  }

  const validation = validateScreenshotStoreBody(raw);
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
  const body = raw as ScreenshotStoreBody;

  // Verify the sig over the canonical-JSON fragment.
  const verifyOk = await verifyScreenshotStoreSignature(body);
  if (!verifyOk) {
    return c.json(
      {
        error: "signature_invalid",
        reason: "Ed25519 verify failed against canonical signed-fragment",
      },
      401,
    );
  }

  // Decode the blob and verify its content-hash matches `blobSha256` in
  // the signed fragment. This is the transitive binding: sig covers
  // blobSha256, so byte-tampering breaks the link without breaking the
  // sig directly. Reject if mismatched.
  let blobBytes: Uint8Array;
  try {
    const buf = Buffer.from(body.blobBase64, "base64");
    blobBytes = new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength);
  } catch {
    return c.json({ error: "invalid_blob", reason: "base64 decode failed" }, 400);
  }
  const computedHash = await sha256Hex(blobBytes);
  if (computedHash.toLowerCase() !== body.blobSha256.toLowerCase()) {
    return c.json(
      {
        error: "blob_hash_mismatch",
        reason: "sha256(blob_bytes) does not match signed blobSha256",
      },
      400,
    );
  }

  const sigKey = await deriveSigKeyHex(body.signature);

  try {
    const { sigKey: storedSigKey, metaKey, blobKey, idempotent } =
      await persistScreenshotRow(c.env, body, verifyOk, blobBytes);
    return c.json({
      ok: true,
      sigKey: storedSigKey,
      pointer: `unbrowse-blob://${storedSigKey}`,
      verify_ok: verifyOk,
      idempotent,
      metaKey,
      blobKey,
      blob_bytes: blobBytes.byteLength,
      _binding_status: "wired",
    });
  } catch (err) {
    if (err instanceof BindingMissingError) {
      return c.json(
        {
          error: "screenshot_blob_binding_missing",
          _binding_missing: "SCREENSHOT_BLOB",
          sigKey,
          verify_ok: verifyOk,
          _wave_hint:
            "operator must run `bunx wrangler kv:namespace create SCREENSHOT_BLOB` " +
            "(and --preview), then paste the ids into backend/wrangler.toml.",
        },
        503,
      );
    }
    throw err;
  }
});

// ─── GET /v1/screenshot/by-sigkey/:sigKey ──────────────────────────────────

screenshotRoutes.get("/v1/screenshot/by-sigkey/:sigKey", async (c: Context<ScreenshotEnv>) => {
  const sigKey = c.req.param("sigKey");
  if (!sigKey || sigKey.length !== 32 || !HEX_RE.test(sigKey)) {
    return c.json({ error: "invalid_sig_key", reason: "must be 32 hex chars" }, 400);
  }

  // Wallet-sig challenge headers (mirrors trace.ts pattern).
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

  // Verify the challenge sig over `<sigKey> || ":" || <ts>`.
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
    const message = `${sigKey}:${tsMs}`;
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
          reason: "WalletSig did not verify over (sigKey || ':' || timestamp)",
        },
        401,
      );
    }
  } catch {
    return c.json({ error: "unauthorized", reason: "challenge verify threw" }, 401);
  }

  try {
    const meta = await readScreenshotMeta(c.env, pubClean, sigKey);
    if (!meta) {
      return c.json({ error: "screenshot_not_found", sigKey }, 404);
    }
    // Defense-in-depth wallet check (Day-2 §G #5).
    if (meta.walletPubkey.toLowerCase().replace(/^0x/, "") !== pubClean) {
      return c.json(
        {
          error: "wallet_mismatch",
          reason: "stored row's walletPubkey does not match the requesting wallet",
        },
        403,
      );
    }

    const blob = await readScreenshotBlob(c.env, pubClean, sigKey);
    if (!blob) {
      return c.json({ error: "screenshot_blob_missing", sigKey }, 404);
    }

    return new Response(blob, {
      status: 200,
      headers: {
        "content-type": "image/png",
        "content-length": String(blob.byteLength),
        "x-unbrowse-sigkey": sigKey,
        "x-unbrowse-blob-sha256": meta.blobSha256,
      },
    });
  } catch (err) {
    if (err instanceof BindingMissingError) {
      return c.json(
        {
          error: "screenshot_blob_binding_missing",
          _binding_missing: "SCREENSHOT_BLOB",
          sigKey,
          _wave_hint:
            "operator must run `bunx wrangler kv:namespace create SCREENSHOT_BLOB` " +
            "(and --preview), then paste the ids into backend/wrangler.toml.",
        },
        503,
      );
    }
    throw err;
  }
});
