/**
 * Session-state routes — v7.2.0-preview.0 (W23 wave, 2026-05-28).
 *
 * Two endpoints under /v1/session/*. Both are wallet-signed; both rely
 * on the wallet pubkey + KV key prefix to enforce cross-wallet isolation.
 *
 *   POST /v1/session/park            — body: wallet-signed SessionParkBody
 *   GET  /v1/session/restore/:id     — header: Authorization: WalletSig <hex>
 *                                      header: X-Wallet-Pubkey: <hex>
 *                                      header: X-Wallet-Timestamp: <unix-ms>
 *
 * Distinct from the legacy `sessionRoutes` in routes/session.ts (exec-token
 * mint). This module is the v7.2 persistent-session surface; the file
 * lives at `routes/session-state.ts` so it does not collide with the
 * pre-existing exec-token export. Both routers mount under /v1.
 *
 * What ships in v7.2.0-preview.0 (post-W23):
 *   - Schema gate (validateSessionParkBody) — REAL; rejects cleartext at wire.
 *   - Ed25519 signature verification — REAL (Web Crypto); same path as audit.ts.
 *   - Deterministic receipt-id derivation — REAL.
 *   - Cross-wallet protection — REAL (wallet-prefixed KV key + sig-verified
 *     pubkey is the only key that produces the prefix).
 *   - KV storage — INERT (BindingMissingError → 503 honest envelope) until
 *     v7.3 provisions SESSION_STATE.
 *
 * Always-wrap rule (Mt 6:19-20): the KV-cached pointer-chain IS the
 * treasure laid up where moth nor rust corrupts. Persistent sessions
 * replace `breath close`'s destructive teardown.
 *
 * Operator provisioning (one-time, BEFORE v7.3 build wave):
 *   bunx wrangler kv:namespace create SESSION_STATE
 *   bunx wrangler kv:namespace create SESSION_STATE --preview
 * Then paste the ids into wrangler.toml's SESSION_STATE stanzas (top-level
 * + each env). Until then this surface returns 503 honestly per W8 pattern.
 */

import { Hono, type Context } from "hono";
import type { Env } from "../types.js";
import {
  validateSessionParkBody,
  verifySessionParkSignature,
  verifyRestoreChallenge,
  deriveReceiptId,
  persistParkedSession,
  readParkedSession,
  bumpLastQueryAt,
  BindingMissingError,
  type SessionParkBody,
} from "../services/session-state.js";

type SessionStateEnv = { Bindings: Env; Variables: Record<string, never> };

export const sessionStateRoutes = new Hono<SessionStateEnv>();

const HEX_RE = /^[0-9a-fA-F]+$/;
// Replay window for restore challenges (matches W18 §A6 pattern).
const RESTORE_CHALLENGE_WINDOW_MS = 60_000;

// ─── POST /v1/session/park ─────────────────────────────────────────────────

sessionStateRoutes.post("/v1/session/park", async (c: Context<SessionStateEnv>) => {
  let raw: unknown;
  try {
    raw = await c.req.json();
  } catch {
    return c.json({ error: "invalid_json", reason: "body must be JSON" }, 400);
  }

  const validation = validateSessionParkBody(raw);
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
  const body = raw as SessionParkBody;

  // Ed25519 verify over canonical signed-fragment. The wallet pubkey is
  // a body field, but the signature commits to that pubkey via canonical
  // serialization — tampering with walletPubkey invalidates the sig.
  const verifyOk = await verifySessionParkSignature(body);
  if (!verifyOk) {
    return c.json(
      {
        error: "signature_invalid",
        reason: "Ed25519 verify failed against canonical signed-fragment",
      },
      401,
    );
  }

  // Deterministic receipt id — caller can predict before sending.
  const receiptId = await deriveReceiptId(body);

  try {
    const { idempotent } = await persistParkedSession(c.env, body, verifyOk);
    return c.json({
      ok: true,
      receiptId,
      verify_ok: verifyOk,
      idempotent,
      parked: true,
      _binding_status: "wired",
    });
  } catch (err) {
    if (err instanceof BindingMissingError) {
      // v7.2.0-preview.0 honest envelope: the SCHEMA + VERIFY path is
      // real, the STORAGE path is inert. Return 200 with parked=false
      // + receiptId so the CLI knows the teardown is accepted but not
      // yet persisted. The CLI never blocks teardown on storage.
      return c.json(
        {
          ok: true,
          receiptId,
          verify_ok: verifyOk,
          parked: false,
          _binding_status: "inert",
          _wave_hint:
            "v7.2.0-preview.0 SESSION_STATE binding absent; v7.3 wires real storage. Run `bunx wrangler kv:namespace create SESSION_STATE` then paste id into wrangler.toml.",
        },
        200,
      );
    }
    throw err;
  }
});

// ─── GET /v1/session/restore/:sessionId ────────────────────────────────────

sessionStateRoutes.get("/v1/session/restore/:sessionId", async (c: Context<SessionStateEnv>) => {
  const sessionId = c.req.param("sessionId");
  if (!sessionId || sessionId.length === 0 || sessionId.length > 256) {
    return c.json({ error: "invalid_session_id", reason: "must be a non-empty short string" }, 400);
  }

  // Three headers required for the challenge:
  //   Authorization: WalletSig <hex>
  //   X-Wallet-Pubkey: <hex>
  //   X-Wallet-Timestamp: <unix-ms>
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
    return c.json(
      {
        error: "unauthorized",
        reason: "X-Wallet-Timestamp must be unix-ms integer",
      },
      401,
    );
  }
  const drift = Math.abs(Date.now() - tsMs);
  if (drift > RESTORE_CHALLENGE_WINDOW_MS) {
    return c.json(
      {
        error: "unauthorized",
        reason: `timestamp drift ${drift}ms exceeds ${RESTORE_CHALLENGE_WINDOW_MS}ms window`,
      },
      401,
    );
  }

  // Verify the challenge sig under the supplied pubkey BEFORE any KV
  // lookup. The wallet pubkey is the second witness (Deut 19:15);
  // it lands in the KV key prefix below for structural cross-wallet
  // isolation.
  const sigOk = await verifyRestoreChallenge(sessionId, tsMs, pubClean, sigHex);
  if (!sigOk) {
    return c.json(
      {
        error: "unauthorized",
        reason: "WalletSig did not verify against (sessionId || ':' || timestamp)",
      },
      401,
    );
  }

  // The KV key is prefixed by the VERIFIED pubkey. A wallet-A request
  // can never produce a key prefixed by wallet-B's pubkey, so the
  // 'cross-wallet 403' case is STRUCTURAL: wallet-A looking for a
  // sessionId that wallet-B parked simply finds an empty key (it
  // reads `session:<walletA>:<id>`, not `session:<walletB>:<id>`).
  //
  // For the operationally-observable case where the SAME wallet
  // wrote a row but its stored walletPubkey diverges from the
  // request (KV corruption), we surface 403 below.
  try {
    const row = await readParkedSession(c.env, pubClean, sessionId);
    if (!row) {
      return c.json(
        {
          error: "session_not_found",
          sessionId,
          reason:
            "no parked-session row at session:<this-wallet>:<sessionId>; either the row is parked under a different wallet (structurally invisible to this signer) or the row does not exist",
        },
        404,
      );
    }
    // Defense-in-depth: verify stored row's walletPubkey matches the
    // request. KV-key-prefix isolation already guarantees this under
    // normal operation; the explicit check makes corruption loud.
    if (row.walletPubkey.toLowerCase().replace(/^0x/, "") !== pubClean) {
      return c.json(
        {
          error: "wallet_mismatch",
          reason:
            "stored row's walletPubkey does not match the requesting wallet — KV row may be corrupted; this should be unreachable under normal operation",
        },
        403,
      );
    }
    // Bump TTL — best-effort; not blocking the response.
    await bumpLastQueryAt(c.env, pubClean, sessionId, row);
    return c.json({
      ok: true,
      sessionId,
      row,
      _binding_status: "wired",
    });
  } catch (err) {
    if (err instanceof BindingMissingError) {
      // v7.2.0-preview.0: SESSION_STATE binding absent. The route
      // returns an HONEST 503 (not 404) so the client distinguishes
      // "the storage substrate is not yet wired" from "your session
      // does not exist".
      return c.json(
        {
          error: "session_state_binding_inert",
          sessionId,
          _wave_hint:
            "v7.2.0-preview.0 SESSION_STATE binding absent; v7.3 wires real storage. The CLI's session-restore handler treats this 503 as honest-empty.",
        },
        503,
      );
    }
    throw err;
  }
});
