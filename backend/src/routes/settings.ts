/**
 * Settings-state routes — v7.2.0-preview.0 (Day-3 Land worker B, 2026-05-28).
 *
 * Two endpoints under /v1/settings/*. Both are wallet-signed; the wallet
 * pubkey + KV key prefix enforces cross-wallet isolation.
 *
 *   POST /v1/settings/set            — body: wallet-signed SettingsSetBody
 *   GET  /v1/settings/get/:keyHash   — wallet-signed challenge headers
 *
 * Prov 16:9 — preferences are deliberate; the wallet IS the access
 * control and the trust root.
 */

import { Hono, type Context } from "hono";
import type { Env } from "../types.js";
import {
  validateSettingsSetBody,
  verifySettingsSetSignature,
  persistSettingsRow,
  readSettingsRow,
  deleteSettingsRow,
  verifyReadChallenge,
  verifyDeleteChallenge,
  deriveCacheKeyHex,
  deriveSettingKeyHash,
  settingsPrimaryKey,
  BindingMissingError,
  type SettingsSetBody,
} from "../services/settings-state.js";

type SettingsEnv = { Bindings: Env; Variables: Record<string, never> };

export const settingsStateRoutes = new Hono<SettingsEnv>();

const HEX_RE = /^[0-9a-fA-F]+$/;
const CHALLENGE_WINDOW_MS = 60_000;

// ─── POST /v1/settings/set ─────────────────────────────────────────────────

settingsStateRoutes.post("/v1/settings/set", async (c: Context<SettingsEnv>) => {
  let raw: unknown;
  try {
    raw = await c.req.json();
  } catch {
    return c.json({ error: "invalid_json", reason: "body must be JSON" }, 400);
  }

  const validation = validateSettingsSetBody(raw);
  if (validation) {
    return c.json(
      {
        error: validation.code ?? "invalid_body",
        field: validation.field,
        reason: validation.reason,
      },
      400,
    );
  }
  const body = raw as SettingsSetBody;

  const verifyOk = await verifySettingsSetSignature(body);
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
  const keyHash = await deriveSettingKeyHash(body.settingKey);

  try {
    const { idempotent, primaryKey } = await persistSettingsRow(c.env, body, verifyOk);
    return c.json({
      ok: true,
      cacheKey,
      keyHash,
      verify_ok: verifyOk,
      idempotent,
      primaryKey,
      _binding_status: "wired",
    });
  } catch (err) {
    if (err instanceof BindingMissingError) {
      return c.json(
        {
          error: "settings_state_binding_missing",
          _binding_missing: "SETTINGS_STATE",
          cacheKey,
          keyHash,
          verify_ok: verifyOk,
          _wave_hint:
            "operator must run `bunx wrangler kv:namespace create SETTINGS_STATE` (and --preview), then paste the ids into backend/wrangler.toml.",
        },
        503,
      );
    }
    throw err;
  }
});

// ─── GET /v1/settings/get/:keyHash ─────────────────────────────────────────

settingsStateRoutes.get("/v1/settings/get/:keyHash", async (c: Context<SettingsEnv>) => {
  const keyHash = c.req.param("keyHash");
  if (!keyHash || keyHash.length !== 32 || !HEX_RE.test(keyHash)) {
    return c.json({ error: "invalid_key_hash", reason: "must be 32 hex chars" }, 400);
  }

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
        reason: "X-Wallet-Pubkey must be 32-byte hex",
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

  const sigOk = await verifyReadChallenge(keyHash, tsMs, pubClean, sigHex);
  if (!sigOk) {
    return c.json(
      {
        error: "unauthorized",
        reason: "WalletSig did not verify over (keyHash || ':' || timestamp)",
      },
      401,
    );
  }

  try {
    const row = await readSettingsRow(c.env, pubClean, keyHash);
    if (!row) {
      return c.json({ error: "setting_not_found", keyHash }, 404);
    }
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
    return c.json({ ok: true, keyHash, row, _binding_status: "wired" });
  } catch (err) {
    if (err instanceof BindingMissingError) {
      return c.json(
        {
          error: "settings_state_binding_missing",
          _binding_missing: "SETTINGS_STATE",
          keyHash,
          _wave_hint:
            "operator must run `bunx wrangler kv:namespace create SETTINGS_STATE` (and --preview), then paste the ids into backend/wrangler.toml.",
        },
        503,
      );
    }
    throw err;
  }
});

// ─── DELETE /v1/settings/:keyHash ──────────────────────────────────────────
//
// Wallet-signed purge endpoint (W24.7). Backs the CLI `eval/settings
// --unset` path that W24.6 purged from the legacy LRP. The signed
// payload is canonical JSON `{"keyHash":"<hex>","timestamp_unix_ms":
// <int>}` — stable key order so the CLI can reproduce byte-for-byte.

settingsStateRoutes.delete("/v1/settings/:keyHash", async (c: Context<SettingsEnv>) => {
  const keyHash = c.req.param("keyHash");
  if (!keyHash || keyHash.length !== 32 || !HEX_RE.test(keyHash)) {
    return c.json({ error: "invalid_key_hash", reason: "must be 32 hex chars" }, 400);
  }

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
        reason: "X-Wallet-Pubkey must be 32-byte hex",
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

  const sigOk = await verifyDeleteChallenge(keyHash, tsMs, pubClean, sigHex);
  if (!sigOk) {
    return c.json(
      {
        error: "unauthorized",
        reason:
          "WalletSig did not verify over canonical JSON {\"keyHash\":<hex>,\"timestamp_unix_ms\":<int>}",
      },
      401,
    );
  }

  const cacheKey = settingsPrimaryKey(pubClean, keyHash);
  try {
    const outcome = await deleteSettingsRow(c.env, pubClean, keyHash);
    if ("wallet_mismatch" in outcome) {
      return c.json(
        {
          error: "wallet_mismatch",
          reason:
            "stored row's walletPubkey does not match the requesting wallet — refusing to delete another wallet's settings row",
          cacheKey,
        },
        403,
      );
    }
    if (outcome.deleted) {
      return c.json({ ok: true, deleted: true, cacheKey, _binding_status: "wired" });
    }
    return c.json({
      ok: true,
      deleted: false,
      idempotent: true,
      cacheKey,
      _binding_status: "wired",
    });
  } catch (err) {
    if (err instanceof BindingMissingError) {
      return c.json(
        {
          error: "settings_state_binding_missing",
          _binding_missing: "SETTINGS_STATE",
          keyHash,
          _wave_hint:
            "operator must run `bunx wrangler kv:namespace create SETTINGS_STATE` (and --preview), then paste the ids into backend/wrangler.toml.",
        },
        503,
      );
    }
    throw err;
  }
});
