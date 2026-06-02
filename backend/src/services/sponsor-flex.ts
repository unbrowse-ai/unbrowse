/**
 * Sponsor-on-Flex (Day 6 / Phase 4a, v6.16.0-preview.0).
 *
 * Swaps the sponsor payment mechanism from direct-SPL transfer (v6.15.0,
 * `sendSponsorPayment` in sponsor-pay.ts) to a Flex authorization signed
 * against a **sponsor-owned** escrow.
 *
 * Architecture
 * ------------
 *   - Platform owns a SPONSOR escrow (separate from agent escrows). Platform
 *     is both the escrow client AND the signer.
 *   - A short-expiry sponsor session key (Ed25519) is registered to that
 *     escrow (24–48h, rotated out-of-band).
 *   - When `maybeSponsor` decides "sponsored", this module signs a Flex
 *     authorization against the SPONSOR escrow with the AGENT's skill splits
 *     (so the platform pays principal AND recoups its 10% in the same
 *     authorization).
 *
 * Gating
 * ------
 *   This module is GATED by `SPONSOR_USE_FLEX_SPLIT=1` (env). When the gate
 *   is off (default), `maybeSponsor` continues to use direct-SPL via
 *   `sendSponsorPayment`. When the gate is on AND the sponsor escrow / session
 *   key are configured, the Flex rail is used.
 *
 *   The flag was named `SPONSOR_USE_CASCADE_SPLIT` in the original v6.16 plan
 *   draft; Day 6 renames to `SPONSOR_USE_FLEX_SPLIT` because Cascade is being
 *   retired in Phase 5 and the name `Cascade` is no longer the splitting
 *   mechanism.
 *
 * SDK boundary
 * ------------
 *   Three exports from `@faremeter/flex-solana` are used here, all confirmed
 *   present in the Day 2 firmament probe of `dist/src/authorization.d.ts` and
 *   `dist/src/index.d.ts`:
 *
 *     • `FLEX_PROGRAM_ADDRESS`           — re-exported from generated/index.js
 *     • `serializePaymentAuthorization`  — produces the bytes signed inline
 *     • `signPaymentAuthorization`       — Web-Crypto Ed25519 signature over
 *                                          the serialized authorization
 *
 *   `findVaultPda`, `getRegisterSessionKeyInstructionAsync`, etc. are NOT
 *   touched today — the sponsor session key registration happens
 *   out-of-band (operator runs a one-shot script when rotating); the
 *   runtime here only signs.
 *
 * What this module does NOT do today
 * ----------------------------------
 *   - Does NOT delete `sendSponsorPayment` (Worker 4 / Phase 5 retires it).
 *   - Does NOT touch the Cascade signer envs (other workers Phase 5).
 *   - Does NOT register / revoke sponsor session keys at runtime (out-of-band).
 *   - Does NOT block the response on facilitator settle — the route caller
 *     fires `facilitator.flush()` via `c.executionCtx.waitUntil` per the same
 *     pattern as the agent-signed Flex flow in `flex-route-helpers.ts`.
 */

import type { Env } from "../types.js";
import type { FlexSplit } from "./flex.js";
import { buildFlexAuthorization } from "./flex.js";

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface SponsorFlexPaymentParams {
  agentId: string;
  /** Skill id (resource) being authorized — copied into the ledger row. */
  skillId: string;
  /** Skill's full splits including the platform recipient (sums to 10000 bps). */
  splits: FlexSplit[];
  /** Max amount the sponsor will authorize, in USDC micro-units (1e-6 USDC). */
  amountUc: bigint;
}

export interface SponsorFlexResult {
  ok: boolean;
  /** On-chain tx signature, if the facilitator submitted synchronously. */
  tx_signature?: string;
  /** The authorization id from the Flex draft (always present when ok=true). */
  authorization_id?: string;
  /** Failure reason when ok=false. Never throws on operational failure. */
  reason?: string;
}

/**
 * Test-injection seam. Production calls this function without overrides; tests
 * pass `_kit` / `_flex` / `_currentSlot` to exercise the assembly + signing
 * logic without real Solana RPC or a real CryptoKeyPair.
 */
export interface SponsorFlexInjections {
  _kit?: typeof import("@solana/kit");
  _flex?: typeof import("@faremeter/flex-solana");
  /** Override for the RPC slot probe — return a bigint slot directly. */
  _currentSlot?: () => Promise<bigint>;
  /**
   * Override for the signer. Receives the serialized message bytes and the
   * raw session-key secret string; must return a 64-byte Ed25519 signature.
   * Tests pass a stub that returns deterministic bytes so we don't need a
   * real CryptoKeyPair.
   */
  _signMessage?: (
    messageBytes: Uint8Array,
    sessionKeySecret: string,
  ) => Promise<Uint8Array>;
}

// ---------------------------------------------------------------------------
// Env helpers
// ---------------------------------------------------------------------------

/**
 * True iff sponsor-on-Flex is fully configured: escrow address, session-key
 * secret, and an RPC URL. RPC env is reused (`CASCADE_RPC_URL`) until Phase 5
 * renames the var; documented in the worker brief.
 */
export function sponsorEscrowReady(env: Env): boolean {
  return Boolean(
    env.FLEX_SPONSOR_ESCROW_ADDRESS?.trim() &&
      env.FLEX_SPONSOR_SESSION_KEY_SECRET?.trim() &&
      env.CASCADE_RPC_URL?.trim(),
  );
}

/**
 * True iff the operator has opted into the Flex rail. Defaults to false so
 * v6.15.0 narrative ("first $1/day on the house, direct SPL") survives a
 * preview deploy by accident.
 *
 * Renamed from `SPONSOR_USE_CASCADE_SPLIT` (Day 2 draft) — see file header.
 */
export function sponsorUseFlex(env: Env): boolean {
  const raw = env.SPONSOR_USE_FLEX_SPLIT?.trim().toLowerCase();
  return raw === "1" || raw === "true" || raw === "yes";
}

// ---------------------------------------------------------------------------
// Sign + submit
// ---------------------------------------------------------------------------

/**
 * Sign a Flex authorization against the sponsor escrow with the skill's
 * splits, returning the authorization id (and tx signature if available).
 *
 * The caller (`sponsor.ts`) decides WHEN to call this; this function only
 * signs + returns the draft + signature for the facilitator to consume.
 *
 * Operational failures never throw — they return `{ ok: false, reason }` so
 * the sponsor middleware can degrade to `exhausted` without exception
 * propagation.
 */
export async function sendSponsorFlexPayment(
  env: Env,
  params: SponsorFlexPaymentParams,
  injections?: SponsorFlexInjections,
): Promise<SponsorFlexResult> {
  if (!sponsorEscrowReady(env)) {
    return { ok: false, reason: "sponsor_escrow_not_configured" };
  }

  // Validate splits up front so a bad input doesn't burn an RPC call.
  if (!params.splits || params.splits.length === 0) {
    return { ok: false, reason: "empty_splits" };
  }
  if (params.amountUc <= 0n) {
    return { ok: false, reason: "non_positive_amount" };
  }

  try {
    // Lazy-load the Solana SDK + Flex SDK (or use injected mocks).
    const kit = injections?._kit ?? (await import("@solana/kit"));
    const flex = injections?._flex ?? (await import("@faremeter/flex-solana"));

    // Current slot — required by buildFlexAuthorization for expiry math.
    let currentSlot: bigint;
    if (injections?._currentSlot) {
      currentSlot = await injections._currentSlot();
    } else {
      const rpc = kit.createSolanaRpc(env.CASCADE_RPC_URL!);
      const rawSlot = await rpc.getSlot().send();
      currentSlot = typeof rawSlot === "bigint" ? rawSlot : BigInt(rawSlot as unknown as number);
    }

    // Assemble (pure, no RPC). buildFlexAuthorization validates split totals
    // and amount bounds and throws on contract violations — let those bubble
    // out to the catch below so the result is `{ ok: false, reason: ... }`.
    const draft = await buildFlexAuthorization(env, {
      agentEscrow: env.FLEX_SPONSOR_ESCROW_ADDRESS!,
      maxAmountUc: params.amountUc,
      splits: params.splits,
      currentSlot,
    });

    // Serialize for Ed25519 signing. The SDK requires every field as either
    // `Address` or `bigint`; the draft stores them as strings (decimal) so
    // the JSON shape is wire-stable. Coerce at the SDK boundary.
    const messageBytes: Uint8Array = flex.serializePaymentAuthorization({
      programId: flex.FLEX_PROGRAM_ADDRESS,
      escrow: kit.address(draft.escrow),
      mint: kit.address(draft.mint),
      maxAmount: BigInt(draft.maxAmount),
      authorizationId: BigInt(draft.authorizationId),
      expiresAtSlot: BigInt(draft.expiresAtSlot),
      splits: draft.splits.map((s) => ({
        recipient: kit.address(s.recipient),
        bps: s.bps,
      })),
    });

    // Sign. Production path imports a CryptoKeyPair from the session-key
    // secret (Ed25519 PKCS#8 / raw 32-byte seed); tests inject `_signMessage`
    // to skip the Web Crypto path entirely.
    let signature: Uint8Array;
    if (injections?._signMessage) {
      signature = await injections._signMessage(
        messageBytes,
        env.FLEX_SPONSOR_SESSION_KEY_SECRET!,
      );
    } else {
      signature = await signMessageWithSessionKey(
        flex,
        messageBytes,
        env.FLEX_SPONSOR_SESSION_KEY_SECRET!,
      );
    }

    if (signature.length !== 64) {
      return {
        ok: false,
        reason: `signature_unexpected_length:${signature.length}`,
      };
    }

    // Settlement against the facilitator happens in the caller — the
    // facilitator already handles the agent-signed flow and the sponsor flow
    // rides the same handler.handleSettle + .flush path. We just return the
    // signed authorization id; tx_signature is populated on the ledger sweep
    // when the facilitator drains.
    return {
      ok: true,
      authorization_id: draft.authorizationId,
    };
  } catch (err) {
    return { ok: false, reason: (err as Error).message };
  }
}

// ---------------------------------------------------------------------------
// Ed25519 signing — Web Crypto path
// ---------------------------------------------------------------------------

/**
 * Sign with the sponsor session key. The Flex SDK's `signPaymentAuthorization`
 * expects a `CryptoKeyPair` (Web Crypto). We import the raw 32-byte seed (the
 * standard Solana Ed25519 secret format) as a PKCS#8 key, then call the SDK.
 *
 * Accepts the same secret-key encodings as `flex-facilitator.ts`:
 *   - JSON-array byte list (`[1,2,3,...]`)
 *   - base58 — fall back to bs58 dynamic import
 *
 * Worker runtime (workerd / Bun) both ship Web Crypto with Ed25519 support
 * under `crypto.subtle`.
 */
async function signMessageWithSessionKey(
  flex: typeof import("@faremeter/flex-solana"),
  message: Uint8Array,
  rawSecret: string,
): Promise<Uint8Array> {
  const seed = await decodeSecretKeyBytes(rawSecret);
  if (seed.length < 32) {
    throw new Error(`session_key_too_short:${seed.length}`);
  }

  // Solana keypairs are 64 bytes: 32-byte seed (priv) || 32-byte pubkey. The
  // raw private key for PKCS#8 import is the leading 32 bytes.
  const privateSeed = seed.slice(0, 32);

  // PKCS#8 wrapper for raw Ed25519 private key:
  //   30 2e 02 01 00 30 05 06 03 2b 65 70 04 22 04 20 || <32-byte seed>
  const pkcs8Header = new Uint8Array([
    0x30, 0x2e, 0x02, 0x01, 0x00, 0x30, 0x05, 0x06, 0x03, 0x2b, 0x65, 0x70,
    0x04, 0x22, 0x04, 0x20,
  ]);
  const pkcs8 = new Uint8Array(pkcs8Header.length + privateSeed.length);
  pkcs8.set(pkcs8Header, 0);
  pkcs8.set(privateSeed, pkcs8Header.length);

  // crypto.subtle.importKey returns one half; the SDK's
  // `signPaymentAuthorization` only uses `keyPair.privateKey` to sign. We
  // pass the same handle for `publicKey` so the type matches; on-chain
  // session-key registration (which actually consumes the public key) is
  // out-of-band, not on this codepath.
  const privateKey = await crypto.subtle.importKey(
    "pkcs8",
    pkcs8.buffer as ArrayBuffer,
    { name: "Ed25519" },
    false,
    ["sign"],
  );

  const keyPair: CryptoKeyPair = {
    privateKey,
    publicKey: privateKey,
  } as CryptoKeyPair;

  return await flex.signPaymentAuthorization({
    message: message as Uint8Array<ArrayBuffer>,
    keyPair,
  });
}

export async function decodeSecretKeyBytes(raw: string): Promise<Uint8Array> {
  const trimmed = raw.trim();
  if (!trimmed) throw new Error("empty_session_key_secret");
  if (trimmed.startsWith("[")) {
    return Uint8Array.from(JSON.parse(trimmed) as number[]);
  }
  // Hex (length >= 64 hex chars = 32 bytes)
  if (/^[0-9a-fA-F]+$/.test(trimmed) && trimmed.length >= 64) {
    const bytes = new Uint8Array(trimmed.length / 2);
    for (let i = 0; i < trimmed.length; i += 2) {
      bytes[i / 2] = parseInt(trimmed.slice(i, i + 2), 16);
    }
    return bytes;
  }
  const { default: bs58 } = (await import("bs58")) as unknown as {
    default: { decode: (s: string) => Uint8Array };
  };
  return Uint8Array.from(bs58.decode(trimmed));
}
