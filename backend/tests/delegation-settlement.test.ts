/**
 * delegation-settlement — Phase 2 witness: settle a paid call against the USER's
 * escrow on the non-custodial delegated funding lane (design §3 step d, §4).
 *
 * Witnesses (chain settlement MOCKED via the SDK-injection seam, like
 * sponsor-flex.test.ts — no real Solana RPC, no real Ed25519 import):
 *   - a delegated key with remaining cap SETTLES a call → debits the rolling cap
 *     ledger by the settled amount; idempotent on a settle replay.
 *   - a call EXCEEDING remaining cap → refused (cap_exhausted), no further draw.
 *   - an EXPIRED delegation → refused (expired), no draw.
 *   - the signed authorization targets `funding.escrow` (the USER's), NOT the
 *     treasury / sponsor escrow.
 *
 * Uses the repo's local-dev KV lane (statsKV → in-process LocalKV) so the cap
 * ledger (recordDelegationDraw / delegationRemaining) is the REAL projection,
 * same harness as delegation-ledger.test.ts.
 */
import { beforeEach, describe, expect, it } from "bun:test";
import { settleDelegatedCall } from "../src/services/delegation-settlement.js";
import {
  delegationSpent,
  delegationRemaining,
  recordDelegationDraw,
} from "../src/services/delegation-ledger.js";
import { LocalKV, clearKVCacheForTests } from "../src/services/kv.js";
import type { Env } from "../src/types.js";
import type { FlexSplit } from "../src/services/flex.js";
import type { SponsorFlexInjections } from "../src/services/sponsor-flex.js";

// Env with the delegation lane CONFIGURED (platform-held delegation session-key
// secret). The escrow is per-user (from the delegation record), not env.
function envDelegated(overrides: Partial<Env> = {}): Env {
  return {
    ENVIRONMENT: "local-dev",
    EMERGENTDB_API_KEY: "x",
    FLEX_DELEGATION_SESSION_KEY_SECRET:
      "[1,2,3,4,5,6,7,8,9,10,11,12,13,14,15,16,17,18,19,20,21,22,23,24,25,26,27,28,29,30,31,32,33,34,35,36,37,38,39,40,41,42,43,44,45,46,47,48,49,50,51,52,53,54,55,56,57,58,59,60,61,62,63,64]",
    ...overrides,
  } as unknown as Env;
}

// SDK-injection stubs: stand in for @solana/kit + @faremeter/flex-solana so the
// signing core runs its REAL serialize/sign/build-authorization arithmetic
// without a real RPC or a real CryptoKeyPair. Mirrors sponsor-flex.test.ts.
function makeInjections(
  overrides: Partial<SponsorFlexInjections> = {},
): SponsorFlexInjections {
  const kit = {
    address: (s: string) => s as unknown as string,
    createSolanaRpc: (_url: string) => ({ getSlot: () => ({ send: async () => 12345n }) }),
  } as unknown as NonNullable<SponsorFlexInjections["_kit"]>;
  const flex = {
    FLEX_PROGRAM_ADDRESS: "FlexProGRamAddress11111111111111111111111111" as unknown as never,
    serializePaymentAuthorization: ((_args: unknown) => new Uint8Array([1, 2, 3, 4])) as unknown,
    signPaymentAuthorization: async (_a: unknown) => new Uint8Array(64).fill(0xab) as unknown,
  } as unknown as NonNullable<SponsorFlexInjections["_flex"]>;
  return {
    _kit: kit,
    _flex: flex,
    _signMessage: async () => new Uint8Array(64).fill(0xab),
    ...overrides,
  };
}

// VERBATIM 402 splits (platform 1000 + creator 9000 = 10000 bps).
const SPLITS: FlexSplit[] = [
  { recipient: "PLatFormReciPienT11111111111111111111111111", bps: 1000 },
  { recipient: "CreaToRReCiPienT11111111111111111111111111", bps: 9000 },
];

const USER_ESCROW = "UserEsCrowPDA1111111111111111111111111111111";
const TREASURY_ESCROW = "TreasurySponsorEscrow1111111111111111111111";
// Current slot < expiry slot → not expired (for the happy paths).
const NOW_SLOT = 1000n;
const FUTURE_EXPIRY = "2000";
const PAST_EXPIRY = "500";

beforeEach(() => {
  clearKVCacheForTests();
  (new LocalKV("stats") as unknown as { store: Map<string, string> }).store.clear();
});

describe("settleDelegatedCall — settles within cap, debits the ledger", () => {
  it("settles a call and debits the rolling cap ledger by the settled amount", async () => {
    const env = envDelegated();
    const keyId = "deleg-settle-1";
    const capUc = 1_000_000;
    const priceUc = 250_000;

    expect(await delegationSpent(env, keyId)).toBe(0);

    const res = await settleDelegatedCall(
      env,
      {
        keyId,
        escrow: USER_ESCROW,
        capUc,
        expiresAtSlot: FUTURE_EXPIRY,
        priceUc,
        splits: SPLITS,
        currentSlot: NOW_SLOT,
      },
      makeInjections(),
    );

    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.settled_uc).toBe(priceUc);
      expect(res.escrow).toBe(USER_ESCROW); // source = USER's escrow
      expect(res.authorization_id).toBeTruthy();
      expect(res.remaining_uc).toBe(capUc - priceUc);
    }
    // The ledger is debited by exactly the settled amount.
    expect(await delegationSpent(env, keyId)).toBe(priceUc);
    expect(await delegationRemaining(env, keyId, capUc)).toBe(capUc - priceUc);
  });

  it("a settle replay (same authorization_id) does NOT double-count the ledger", async () => {
    const env = envDelegated();
    const keyId = "deleg-settle-replay";
    const capUc = 1_000_000;
    const priceUc = 100_000;

    const first = await settleDelegatedCall(
      env,
      { keyId, escrow: USER_ESCROW, capUc, expiresAtSlot: FUTURE_EXPIRY, priceUc, splits: SPLITS, currentSlot: NOW_SLOT },
      makeInjections(),
    );
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    const authId = first.authorization_id;
    expect(await delegationSpent(env, keyId)).toBe(priceUc);

    // Re-record the SAME authorization id (the settle-side replay path). The
    // idempotent ledger must treat it as a no-op — no double-count.
    const replay = await recordDelegationDraw(env, keyId, { authorization_id: authId, amount_uc: priceUc });
    expect(replay.ok).toBe(true);
    expect(await delegationSpent(env, keyId)).toBe(priceUc); // NOT 2x
  });
});

describe("settleDelegatedCall — cap enforcement", () => {
  it("refuses a call that exceeds the remaining cap (no draw recorded)", async () => {
    const env = envDelegated();
    const keyId = "deleg-cap-exhausted";
    const capUc = 100_000;

    // Exhaust the cap with a prior draw.
    await recordDelegationDraw(env, keyId, { authorization_id: "prior", amount_uc: 100_000 });
    expect(await delegationRemaining(env, keyId, capUc)).toBe(0);

    const res = await settleDelegatedCall(
      env,
      { keyId, escrow: USER_ESCROW, capUc, expiresAtSlot: FUTURE_EXPIRY, priceUc: 50_000, splits: SPLITS, currentSlot: NOW_SLOT },
      makeInjections(),
    );

    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.reason).toBe("cap_exhausted");
    // No new draw was recorded — spend stays at the prior 100_000.
    expect(await delegationSpent(env, keyId)).toBe(100_000);
  });

  it("clamps maxAmount to remaining headroom (price > remaining settles the remainder)", async () => {
    const env = envDelegated();
    const keyId = "deleg-cap-clamp";
    const capUc = 100_000;
    // Already drew 70_000 → 30_000 headroom; a 50_000 call clamps to 30_000.
    await recordDelegationDraw(env, keyId, { authorization_id: "prior2", amount_uc: 70_000 });

    const res = await settleDelegatedCall(
      env,
      { keyId, escrow: USER_ESCROW, capUc, expiresAtSlot: FUTURE_EXPIRY, priceUc: 50_000, splits: SPLITS, currentSlot: NOW_SLOT },
      makeInjections(),
    );

    expect(res.ok).toBe(true);
    if (res.ok) expect(res.settled_uc).toBe(30_000); // clamped to headroom
    expect(await delegationSpent(env, keyId)).toBe(100_000); // exactly at cap
    expect(await delegationRemaining(env, keyId, capUc)).toBe(0);
  });
});

describe("settleDelegatedCall — expiry enforcement", () => {
  it("refuses an expired delegation (no draw recorded)", async () => {
    const env = envDelegated();
    const keyId = "deleg-expired";
    const capUc = 1_000_000;

    const res = await settleDelegatedCall(
      env,
      {
        keyId,
        escrow: USER_ESCROW,
        capUc,
        expiresAtSlot: PAST_EXPIRY, // 500 < currentSlot 1000 → expired
        priceUc: 50_000,
        splits: SPLITS,
        currentSlot: NOW_SLOT,
      },
      makeInjections(),
    );

    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.reason).toBe("expired");
    expect(await delegationSpent(env, keyId)).toBe(0); // nothing drawn
  });
});

describe("settleDelegatedCall — source is the USER's escrow, NEVER treasury", () => {
  it("signs the authorization against funding.escrow (the user's), not the sponsor/treasury escrow", async () => {
    // Capture the serialize args to assert the escrow the signer was pointed at.
    const env = envDelegated({
      // Even with a sponsor/treasury escrow present in env, the delegated lane
      // must sign against the USER's escrow from the record, never this one.
      FLEX_SPONSOR_ESCROW_ADDRESS: TREASURY_ESCROW,
    } as Partial<Env>);
    const keyId = "deleg-escrow-source";

    let capturedEscrow: string | null = null;
    const flexStub = {
      FLEX_PROGRAM_ADDRESS: "FlexProGRamAddress11111111111111111111111111" as unknown as never,
      serializePaymentAuthorization: ((args: { escrow?: unknown }) => {
        capturedEscrow = String(args.escrow);
        return new Uint8Array([1]);
      }) as unknown,
      signPaymentAuthorization: async (_a: unknown) => new Uint8Array(64).fill(0xab) as unknown,
    } as unknown as NonNullable<SponsorFlexInjections["_flex"]>;

    const res = await settleDelegatedCall(
      env,
      { keyId, escrow: USER_ESCROW, capUc: 1_000_000, expiresAtSlot: FUTURE_EXPIRY, priceUc: 50_000, splits: SPLITS, currentSlot: NOW_SLOT },
      makeInjections({ _flex: flexStub }),
    );

    expect(res.ok).toBe(true);
    expect(capturedEscrow).toBe(USER_ESCROW); // funds source = USER escrow
    expect(capturedEscrow).not.toBe(TREASURY_ESCROW); // never the treasury
  });

  it("refuses when the delegation lane is not configured (no session-key secret)", async () => {
    const env = envDelegated({ FLEX_DELEGATION_SESSION_KEY_SECRET: undefined } as Partial<Env>);
    const res = await settleDelegatedCall(
      env,
      { keyId: "k", escrow: USER_ESCROW, capUc: 1_000_000, expiresAtSlot: FUTURE_EXPIRY, priceUc: 50_000, splits: SPLITS, currentSlot: NOW_SLOT },
      makeInjections(),
    );
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.reason).toBe("delegation_not_configured");
  });
});
