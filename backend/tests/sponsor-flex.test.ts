/**
 * Day 6 (Genesis Dominion) — Phase 4a sponsor-on-Flex tests.
 *
 * Exercises the swap from direct-SPL `sendSponsorPayment` to a Flex
 * authorization signed against the sponsor escrow.
 *
 * No real Solana RPC, no real Web Crypto Ed25519 import — `sendSponsorFlexPayment`
 * declares an explicit `SponsorFlexInjections` seam so tests pass:
 *
 *   - `_kit`           : a stub of @solana/kit (only `address`, `createSolanaRpc`)
 *   - `_flex`          : a stub of @faremeter/flex-solana (the three exports we use)
 *   - `_currentSlot`   : a bigint promise to skip the RPC probe
 *   - `_signMessage`   : a fake signer returning a fixed 64-byte signature
 *
 * Per CLAUDE.md "Never mock in tests": the test fakes the *external SDKs* via
 * the declared injection points; everything else (env reads, gate logic,
 * buildFlexAuthorization arithmetic, split validation, JSON shaping) runs on
 * real production code.
 */

import { describe, expect, test } from "bun:test";

import {
  sendSponsorFlexPayment,
  sponsorEscrowReady,
  sponsorUseFlex,
  type SponsorFlexInjections,
} from "../src/services/sponsor-flex.js";
import type { Env } from "../src/types.js";
import type { FlexSplit } from "../src/services/flex.js";

// ---------------------------------------------------------------------------
// Env fixtures
// ---------------------------------------------------------------------------

function envBase(): Env {
  return {
    API_KEY: "x",
    EMERGENTDB_API_KEY: "x",
    NEBIUS_API_KEY: "x",
    TURBOBOX_URL: "x",
    FAL_KEY: "x",
    R2_BUCKET: {} as R2Bucket,
    STATS_KV: {} as KVNamespace,
    ENVIRONMENT: "local-dev",
  } as Env;
}

function envFlexReady(overrides: Partial<Env> = {}): Env {
  return {
    ...envBase(),
    FLEX_SPONSOR_ESCROW_ADDRESS: "FLeXEscRowAddRessAaaaaaaaaaaaaaaaaaaaaaaa11",
    FLEX_SPONSOR_SESSION_KEY_SECRET: "[1,2,3,4,5,6,7,8,9,10,11,12,13,14,15,16,17,18,19,20,21,22,23,24,25,26,27,28,29,30,31,32,33,34,35,36,37,38,39,40,41,42,43,44,45,46,47,48,49,50,51,52,53,54,55,56,57,58,59,60,61,62,63,64]",
    CASCADE_RPC_URL: "https://rpc.example/local",
    SPONSOR_USE_FLEX_SPLIT: "1",
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Stub builders for the SDK injection seam
// ---------------------------------------------------------------------------

function makeKitStub(): NonNullable<SponsorFlexInjections["_kit"]> {
  // We only need `address` (identity-ish wrapper) for serializePaymentAuthorization
  // and `createSolanaRpc` (which the function bypasses via _currentSlot).
  const kit = {
    address: (s: string) => s as unknown as string,
    createSolanaRpc: (_url: string) => ({
      getSlot: () => ({ send: async () => 12345n }),
    }),
  } as unknown as NonNullable<SponsorFlexInjections["_kit"]>;
  return kit;
}

function makeFlexStub(opts?: {
  serializeFn?: (args: unknown) => Uint8Array;
}): NonNullable<SponsorFlexInjections["_flex"]> {
  return {
    FLEX_PROGRAM_ADDRESS: "FlexProGRamAddress11111111111111111111111111" as unknown as never,
    serializePaymentAuthorization: opts?.serializeFn
      ? opts.serializeFn
      : ((_args: unknown) => new Uint8Array([1, 2, 3, 4])) as unknown,
    signPaymentAuthorization: async (_a: unknown) =>
      new Uint8Array(64).fill(0xab) as unknown,
  } as unknown as NonNullable<SponsorFlexInjections["_flex"]>;
}

function makeInjections(
  overrides: Partial<SponsorFlexInjections> = {},
): SponsorFlexInjections {
  return {
    _kit: makeKitStub(),
    _flex: makeFlexStub(),
    _currentSlot: async () => 12345n,
    _signMessage: async () => new Uint8Array(64).fill(0xab),
    ...overrides,
  };
}

// A valid 10000-bps splits array (platform 1000 + creator 9000).
const STD_SPLITS: FlexSplit[] = [
  { recipient: "PLatFormReciPienT11111111111111111111111111", bps: 1000 },
  { recipient: "CreaToRReCiPienT11111111111111111111111111", bps: 9000 },
];

// ---------------------------------------------------------------------------
// Pure env helpers
// ---------------------------------------------------------------------------

describe("sponsor-flex env helpers", () => {
  test("sponsorUseFlex defaults to false when env unset", () => {
    expect(sponsorUseFlex(envBase())).toBe(false);
  });

  test("sponsorUseFlex returns true when SPONSOR_USE_FLEX_SPLIT='1'", () => {
    expect(sponsorUseFlex({ ...envBase(), SPONSOR_USE_FLEX_SPLIT: "1" })).toBe(true);
  });

  test("sponsorUseFlex accepts 'true' and 'yes' aliases", () => {
    expect(sponsorUseFlex({ ...envBase(), SPONSOR_USE_FLEX_SPLIT: "true" })).toBe(true);
    expect(sponsorUseFlex({ ...envBase(), SPONSOR_USE_FLEX_SPLIT: "yes" })).toBe(true);
  });

  test("sponsorUseFlex returns false on '0' / empty / unrecognised", () => {
    expect(sponsorUseFlex({ ...envBase(), SPONSOR_USE_FLEX_SPLIT: "0" })).toBe(false);
    expect(sponsorUseFlex({ ...envBase(), SPONSOR_USE_FLEX_SPLIT: "" })).toBe(false);
    expect(sponsorUseFlex({ ...envBase(), SPONSOR_USE_FLEX_SPLIT: "no" })).toBe(false);
  });

  test("sponsorEscrowReady is false when escrow address is missing", () => {
    const env = envFlexReady({ FLEX_SPONSOR_ESCROW_ADDRESS: undefined });
    expect(sponsorEscrowReady(env)).toBe(false);
  });

  test("sponsorEscrowReady is false when session key secret is missing", () => {
    const env = envFlexReady({ FLEX_SPONSOR_SESSION_KEY_SECRET: undefined });
    expect(sponsorEscrowReady(env)).toBe(false);
  });

  test("sponsorEscrowReady is false when RPC URL is missing", () => {
    const env = envFlexReady({ CASCADE_RPC_URL: undefined });
    expect(sponsorEscrowReady(env)).toBe(false);
  });

  test("sponsorEscrowReady is true when all three vars are set", () => {
    expect(sponsorEscrowReady(envFlexReady())).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// sendSponsorFlexPayment
// ---------------------------------------------------------------------------

describe("sendSponsorFlexPayment", () => {
  test("returns ok=false:sponsor_escrow_not_configured when sponsor escrow not configured", async () => {
    const env = envFlexReady({ FLEX_SPONSOR_ESCROW_ADDRESS: undefined });
    const result = await sendSponsorFlexPayment(env, {
      agentId: "agent-A",
      skillId: "skill-1",
      splits: STD_SPLITS,
      amountUc: 1000n,
    });
    expect(result.ok).toBe(false);
    expect(result.reason).toBe("sponsor_escrow_not_configured");
  });

  test("returns ok=false:empty_splits when splits array is empty", async () => {
    const env = envFlexReady();
    const result = await sendSponsorFlexPayment(
      env,
      { agentId: "agent-A", skillId: "skill-1", splits: [], amountUc: 1000n },
      makeInjections(),
    );
    expect(result.ok).toBe(false);
    expect(result.reason).toBe("empty_splits");
  });

  test("returns ok=false:non_positive_amount when amountUc <= 0", async () => {
    const env = envFlexReady();
    const result = await sendSponsorFlexPayment(
      env,
      { agentId: "agent-A", skillId: "skill-1", splits: STD_SPLITS, amountUc: 0n },
      makeInjections(),
    );
    expect(result.ok).toBe(false);
    expect(result.reason).toBe("non_positive_amount");
  });

  test("returns ok=true + authorization_id when env is configured and SDK stubs succeed", async () => {
    const env = envFlexReady();
    const result = await sendSponsorFlexPayment(
      env,
      { agentId: "agent-A", skillId: "skill-1", splits: STD_SPLITS, amountUc: 1000n },
      makeInjections(),
    );
    expect(result.ok).toBe(true);
    expect(result.authorization_id).toBeTruthy();
    expect(typeof result.authorization_id).toBe("string");
    // authorizationId is a decimal-stringified random u64; non-empty digit string.
    expect(/^\d+$/.test(result.authorization_id!)).toBe(true);
  });

  test("propagates buildFlexAuthorization validation failure as ok=false:reason", async () => {
    const env = envFlexReady();
    // 1000 + 8000 != 10000 → buildFlexAuthorization throws
    const badSplits: FlexSplit[] = [
      { recipient: "A", bps: 1000 },
      { recipient: "B", bps: 8000 },
    ];
    const result = await sendSponsorFlexPayment(
      env,
      { agentId: "agent-A", skillId: "skill-1", splits: badSplits, amountUc: 1000n },
      makeInjections(),
    );
    expect(result.ok).toBe(false);
    expect(result.reason).toContain("9000 != 10000");
  });

  test("returns ok=false:signature_unexpected_length when signer returns wrong-size signature", async () => {
    const env = envFlexReady();
    const result = await sendSponsorFlexPayment(
      env,
      { agentId: "agent-A", skillId: "skill-1", splits: STD_SPLITS, amountUc: 1000n },
      makeInjections({
        _signMessage: async () => new Uint8Array(63), // 63 != 64
      }),
    );
    expect(result.ok).toBe(false);
    expect(result.reason).toMatch(/signature_unexpected_length/);
  });

  test("calls serializePaymentAuthorization with mint='EPjFW…' and the supplied splits", async () => {
    // Mint is network-driven (resolveFlexNetwork); assert the mainnet mint under
    // explicit mainnet config.
    const env = envFlexReady({ X402_NETWORK_MODE: "mainnet" });
    let capturedArgs: Record<string, unknown> | null = null;
    const result = await sendSponsorFlexPayment(
      env,
      { agentId: "agent-A", skillId: "skill-1", splits: STD_SPLITS, amountUc: 1000n },
      makeInjections({
        _flex: makeFlexStub({
          serializeFn: (args) => {
            capturedArgs = args as Record<string, unknown>;
            return new Uint8Array([0]);
          },
        }),
      }),
    );
    expect(result.ok).toBe(true);
    expect(capturedArgs).not.toBeNull();
    // USDC mainnet mint comes from flex.ts buildFlexAuthorization (USDC_MINT_MAINNET).
    expect(String((capturedArgs as Record<string, unknown>)!.mint)).toContain(
      "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
    );
    expect(BigInt((capturedArgs as Record<string, unknown>)!.maxAmount as bigint)).toBe(1000n);
    expect(
      (capturedArgs as { splits: { bps: number }[] }).splits.map((s) => s.bps),
    ).toEqual([1000, 9000]);
  });
});
