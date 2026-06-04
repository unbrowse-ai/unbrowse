/**
 * Flex facilitator service tests (Day 5, v6.16.0).
 *
 * No Solana RPC, no real Faremeter init — uses the `opts.handler` DI seam to
 * inject a stub that conforms to the FlexFacilitatorHandler structural type.
 * The DI pattern matches sponsor.ts's `payFn` injection that CLAUDE.md
 * sanctions.
 *
 * What we DO test:
 *  - wrapper contract: verify/settle/flush/stop/supported pass through correctly
 *  - error path: handler throwing inside verify/settle does NOT escape — the
 *    wrapper catches and returns `{ok: false, reason}` so route helpers can
 *    surface a clean 402 instead of a 5xx
 *  - env guards: missing FLEX_PLATFORM_FACILITATOR_KEY /
 *    FLEX_PLATFORM_RECIPIENT_USDC_ATA / CASCADE_RPC_URL throw a clear error
 *  - flush adapts Faremeter's `FlushResult[]` to a `{submitted, finalized}` count
 *
 * What we DO NOT test here:
 *  - the real Faremeter handler — that requires a live Solana RPC and is the
 *    domain of integration tests + the Day-9 audit deploy verification
 */
import { describe, test, expect, beforeEach } from "bun:test";
import {
  createFlexFacilitator,
  resetFlexFacilitatorCacheForTests,
  platformRecipientUsdcAta,
  flexRefundTimeoutSlots,
  resolveFlexNetwork,
  type FlexFacilitatorHandler,
} from "../src/services/flex-facilitator.js";
import type { Env } from "../src/types.js";

function makeStubHandler(overrides: Partial<FlexFacilitatorHandler> = {}): FlexFacilitatorHandler {
  return {
    getSupported: () => [
      Promise.resolve({
        x402Version: 2,
        scheme: "flex",
        network: "solana",
        extra: {},
      }),
    ],
    getRequirements: async () => [],
    handleVerify: async () => ({ isValid: true, payer: "PayerAddr11111111111111111111111111111111111" }),
    handleSettle: async () => ({
      success: true,
      transaction: "12345678901234567890",
      network: "solana",
      payer: "PayerAddr11111111111111111111111111111111111",
    }),
    flush: async () => [],
    stop: () => {},
    ...overrides,
  };
}

function samplePayload(): Record<string, unknown> {
  return {
    scheme: "flex",
    network: "solana",
    payload: {
      escrow: "Escrow1111111111111111111111111111111111111",
      mint: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
      maxAmount: "1000000",
      authorizationId: "12345678901234567890",
      expiresAtSlot: "100150",
      sessionKey: "SessKey1111111111111111111111111111111111111",
      signature: "AAAA",
      splits: [{ recipient: "Platform11111111111111111111111111111111111", bps: 10000 }],
    },
  };
}

function makeEnv(overrides: Partial<Env> = {}): Env {
  return {
    API_KEY: "test",
    EMERGENTDB_API_KEY: "test",
    NEBIUS_API_KEY: "test",
    TURBOBOX_URL: "http://test",
    FAL_KEY: "test",
    STATS_KV: {} as unknown as KVNamespace,
    R2_BUCKET: {} as unknown as R2Bucket,
    FLEX_PLATFORM_FACILITATOR_KEY:
      "[1,2,3,4,5,6,7,8,9,10,11,12,13,14,15,16,17,18,19,20,21,22,23,24,25,26,27,28,29,30,31,32,33,34,35,36,37,38,39,40,41,42,43,44,45,46,47,48,49,50,51,52,53,54,55,56,57,58,59,60,61,62,63,64]",
    FLEX_PLATFORM_RECIPIENT_USDC_ATA: "PlatformAta11111111111111111111111111111111",
    CASCADE_RPC_URL: "https://api.mainnet-beta.solana.com",
    CASCADE_RPC_WS_URL: "wss://api.mainnet-beta.solana.com",
    ...overrides,
  } as Env;
}

describe("flex-facilitator — Day 5 createFlexFacilitator", () => {
  beforeEach(() => {
    resetFlexFacilitatorCacheForTests();
  });

  test("golden: verify accepts a well-formed payload and returns holdId from authorizationId", async () => {
    const stub = makeStubHandler();
    const handle = await createFlexFacilitator(makeEnv(), { handler: stub });

    const r = await handle.verify(samplePayload());
    expect(r.ok).toBe(true);
    expect(r.holdId).toBe("12345678901234567890");
  });

  test("golden: settle after verify returns txSignature from handleSettle.transaction", async () => {
    const stub = makeStubHandler();
    const handle = await createFlexFacilitator(makeEnv(), { handler: stub });

    const verifyResult = await handle.verify(samplePayload());
    expect(verifyResult.ok).toBe(true);

    const settleResult = await handle.settle(verifyResult.holdId!, 500_000n);
    expect(settleResult.ok).toBe(true);
    expect(settleResult.txSignature).toBe("12345678901234567890");
  });

  test("golden: supported returns resolved x402 kinds", async () => {
    const stub = makeStubHandler();
    const handle = await createFlexFacilitator(makeEnv(), { handler: stub });
    const sup = await handle.supported();
    expect(Array.isArray(sup)).toBe(true);
    expect(sup.length).toBe(1);
    expect((sup[0] as { scheme: string }).scheme).toBe("flex");
  });

  test("flush counts submitted holds from Faremeter FlushResult[]", async () => {
    const stub = makeStubHandler({
      flush: async () => [
        { authorizationId: 1n, success: true, transaction: "sig1" },
        { authorizationId: 2n, success: false, error: "Custom:6028" },
        { authorizationId: 3n, success: true, transaction: "sig3" },
      ],
    });
    const handle = await createFlexFacilitator(makeEnv(), { handler: stub });
    const f = await handle.flush();
    expect(f.submitted).toBe(2);
    expect(f.finalized).toBe(0); // TODO Day-6: surface Faremeter's finalizeReady count
    expect(f.results.length).toBe(3);
  });

  test("edge: throws on missing FLEX_PLATFORM_FACILITATOR_KEY", async () => {
    const env = makeEnv({ FLEX_PLATFORM_FACILITATOR_KEY: "" });
    let thrown: unknown = null;
    try {
      await createFlexFacilitator(env);
    } catch (e) {
      thrown = e;
    }
    expect(thrown).toBeInstanceOf(Error);
    expect((thrown as Error).message).toContain("FLEX_PLATFORM_FACILITATOR_KEY");
  });

  test("edge: throws on missing FLEX_PLATFORM_RECIPIENT_USDC_ATA", async () => {
    const env = makeEnv({ FLEX_PLATFORM_RECIPIENT_USDC_ATA: "" });
    let thrown: unknown = null;
    try {
      await createFlexFacilitator(env);
    } catch (e) {
      thrown = e;
    }
    expect(thrown).toBeInstanceOf(Error);
    expect((thrown as Error).message).toContain("FLEX_PLATFORM_RECIPIENT_USDC_ATA");
  });

  test("edge: throws on missing CASCADE_RPC_URL", async () => {
    const env = makeEnv({ CASCADE_RPC_URL: "" });
    let thrown: unknown = null;
    try {
      await createFlexFacilitator(env);
    } catch (e) {
      thrown = e;
    }
    expect(thrown).toBeInstanceOf(Error);
    expect((thrown as Error).message).toContain("CASCADE_RPC_URL");
  });

  test("adversarial: handleVerify throws — verify catches and returns ok:false with reason", async () => {
    const stub = makeStubHandler({
      handleVerify: async () => {
        throw new Error("rpc unreachable");
      },
    });
    const handle = await createFlexFacilitator(makeEnv(), { handler: stub });
    const r = await handle.verify(samplePayload());
    expect(r.ok).toBe(false);
    expect(r.reason).toContain("rpc unreachable");
  });

  test("adversarial: handleVerify returns {isValid:false} — verify propagates invalidReason", async () => {
    const stub = makeStubHandler({
      handleVerify: async () => ({ isValid: false, invalidReason: "Session key has expired" }),
    });
    const handle = await createFlexFacilitator(makeEnv(), { handler: stub });
    const r = await handle.verify(samplePayload());
    expect(r.ok).toBe(false);
    expect(r.reason).toBe("Session key has expired");
  });

  test("adversarial: handleVerify returns null — verify reports facilitator_declined", async () => {
    const stub = makeStubHandler({
      handleVerify: async () => null,
    });
    const handle = await createFlexFacilitator(makeEnv(), { handler: stub });
    const r = await handle.verify(samplePayload());
    expect(r.ok).toBe(false);
    expect(r.reason).toBe("facilitator_declined");
  });

  test("adversarial: handleSettle returns errorReason — settle surfaces it", async () => {
    const stub = makeStubHandler({
      handleSettle: async () => ({
        success: false,
        transaction: "",
        network: "solana",
        errorReason: "Settle amount exceeds client-authorized maxAmount",
      }),
    });
    const handle = await createFlexFacilitator(makeEnv(), { handler: stub });
    await handle.verify(samplePayload());
    const r = await handle.settle("12345678901234567890", 9_000_000n);
    expect(r.ok).toBe(false);
    expect(r.reason).toContain("maxAmount");
  });

  test("adversarial: settle without prior verify returns no_pending_hold_for_id", async () => {
    const stub = makeStubHandler();
    const handle = await createFlexFacilitator(makeEnv(), { handler: stub });
    const r = await handle.settle("unknown-id", 1n);
    expect(r.ok).toBe(false);
    expect(r.reason).toBe("no_pending_hold_for_id");
  });

  test("adversarial: handleSettle throws — settle catches and returns ok:false", async () => {
    const stub = makeStubHandler({
      handleSettle: async () => {
        throw new Error("blockhash expired");
      },
    });
    const handle = await createFlexFacilitator(makeEnv(), { handler: stub });
    await handle.verify(samplePayload());
    const r = await handle.settle("12345678901234567890", 1n);
    expect(r.ok).toBe(false);
    expect(r.reason).toContain("blockhash expired");
  });

  test("caching: second create with new DI handler returns fresh handle", async () => {
    const stub1 = makeStubHandler();
    const stub2 = makeStubHandler({
      handleVerify: async () => ({ isValid: false, invalidReason: "test marker" }),
    });
    const h1 = await createFlexFacilitator(makeEnv(), { handler: stub1 });
    const h2 = await createFlexFacilitator(makeEnv(), { handler: stub2 });
    expect(h1.handler).toBe(stub1);
    expect(h2.handler).toBe(stub2);
    const v = await h2.verify(samplePayload());
    expect(v.ok).toBe(false);
    expect(v.reason).toBe("test marker");
  });

  test("stop clears the isolate cache so subsequent create rebuilds", async () => {
    const stub1 = makeStubHandler();
    const h1 = await createFlexFacilitator(makeEnv(), { handler: stub1 });
    await h1.stop();
    // After stop, a no-handler call would attempt real Faremeter init —
    // verify by checking that env guard still fires (proves we're past
    // the cache hit and went into the real path).
    let thrown: unknown = null;
    try {
      await createFlexFacilitator(makeEnv({ FLEX_PLATFORM_FACILITATOR_KEY: "" }));
    } catch (e) {
      thrown = e;
    }
    expect(thrown).toBeInstanceOf(Error);
  });
});

describe("flex-facilitator — Day 3 helpers preserved", () => {
  test("platformRecipientUsdcAta returns trimmed ATA", () => {
    const env = makeEnv({
      FLEX_PLATFORM_RECIPIENT_USDC_ATA: "  EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v  ",
    });
    expect(platformRecipientUsdcAta(env)).toBe("EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v");
  });

  test("platformRecipientUsdcAta throws on empty", () => {
    const env = makeEnv({ FLEX_PLATFORM_RECIPIENT_USDC_ATA: "" });
    expect(() => platformRecipientUsdcAta(env)).toThrow("FLEX_PLATFORM_RECIPIENT_USDC_ATA");
  });

  test("flexRefundTimeoutSlots: default 150 when unset", () => {
    const env = makeEnv({ FLEX_REFUND_TIMEOUT_SLOTS: undefined });
    expect(flexRefundTimeoutSlots(env)).toBe(150n);
  });

  test("flexRefundTimeoutSlots: clamps below min", () => {
    const env = makeEnv({ FLEX_REFUND_TIMEOUT_SLOTS: "50" });
    expect(flexRefundTimeoutSlots(env)).toBe(150n);
  });

  test("flexRefundTimeoutSlots: clamps above max", () => {
    const env = makeEnv({ FLEX_REFUND_TIMEOUT_SLOTS: "99999999" });
    expect(flexRefundTimeoutSlots(env)).toBe(1_296_000n);
  });

  test("flexRefundTimeoutSlots: passes through valid", () => {
    const env = makeEnv({ FLEX_REFUND_TIMEOUT_SLOTS: "500" });
    expect(flexRefundTimeoutSlots(env)).toBe(500n);
  });
});

describe("flex-facilitator — resolveFlexNetwork (config-driven, not hardcoded)", () => {
  const MAINNET_USDC = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
  const DEVNET_USDC = "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU";

  test("X402_NETWORK_MODE=mainnet -> mainnet + mainnet USDC", () => {
    expect(resolveFlexNetwork({ X402_NETWORK_MODE: "mainnet", ENVIRONMENT: "staging" }))
      .toEqual({ network: "mainnet", usdcMint: MAINNET_USDC });
  });

  test("X402_NETWORK_MODE=testnet -> devnet + devnet USDC (where the FLEX program lives)", () => {
    expect(resolveFlexNetwork({ X402_NETWORK_MODE: "testnet", ENVIRONMENT: "production" }))
      .toEqual({ network: "devnet", usdcMint: DEVNET_USDC });
  });

  test("production default (no mode) -> mainnet", () => {
    expect(resolveFlexNetwork({ ENVIRONMENT: "production" }))
      .toEqual({ network: "mainnet", usdcMint: MAINNET_USDC });
  });

  test("non-production default (no mode) -> devnet (so settlement can actually succeed)", () => {
    expect(resolveFlexNetwork({ ENVIRONMENT: "staging" }))
      .toEqual({ network: "devnet", usdcMint: DEVNET_USDC });
    expect(resolveFlexNetwork({}).network).toBe("devnet");
  });
});
