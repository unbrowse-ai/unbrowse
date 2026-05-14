/**
 * Day 3 (Genesis Land) seed tests for the sponsor middleware.
 *
 * The three pure env-helpers must pass (5 cases). The async decision function
 * `maybeSponsor` is an honest stub that throws — proving the seam is planted
 * but no real USDC logic runs yet (1 case).
 *
 * Day 4 will replace the stub and add the cap-check + ledger-write tests.
 */

import { describe, expect, test } from "bun:test";

import {
  maybeSponsor,
  sponsorCapDailyUsd,
  sponsorGlobalCapDailyUsd,
  sponsorWalletReady,
  type SponsorEnv,
} from "../src/middleware/sponsor.js";

describe("sponsor middleware — pure helpers (Day 3 seed)", () => {
  test("sponsorWalletReady is false when address is missing", () => {
    const env: SponsorEnv = { PLATFORM_SPONSOR_WALLET_KEY: "key123" };
    expect(sponsorWalletReady(env)).toBe(false);
  });

  test("sponsorWalletReady is false when key is missing", () => {
    const env: SponsorEnv = { PLATFORM_SPONSOR_WALLET_ADDRESS: "So1abc" };
    expect(sponsorWalletReady(env)).toBe(false);
  });

  test("sponsorWalletReady is true when both address and key are set", () => {
    const env: SponsorEnv = {
      PLATFORM_SPONSOR_WALLET_ADDRESS: "So1abc",
      PLATFORM_SPONSOR_WALLET_KEY: "key123",
    };
    expect(sponsorWalletReady(env)).toBe(true);
  });

  test("sponsorCapDailyUsd defaults to 1.0 when env var is unset", () => {
    expect(sponsorCapDailyUsd({})).toBe(1.0);
  });

  test("sponsorCapDailyUsd parses '2.5' to 2.5", () => {
    expect(sponsorCapDailyUsd({ SPONSOR_CAP_DAILY_USD: "2.5" })).toBe(2.5);
  });
});

describe("sponsor middleware — decision matrix seed (Day 3)", () => {
  test("maybeSponsor rejects with 'not yet implemented' (honest seed)", async () => {
    // Synthesize a minimal Context — the stub never reads it. Cast through
    // unknown because the real Hono Context is heavy and we just need the
    // stub to reject before touching anything.
    const fakeContext = {} as unknown as Parameters<typeof maybeSponsor>[0];
    const terms: Parameters<typeof maybeSponsor>[1] = [
      {
        scheme: "exact",
        network: "solana",
        amount: "1000",
        asset: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
        payTo: "So1abc",
        maxTimeoutSeconds: 300,
      },
    ];
    expect(maybeSponsor(fakeContext, terms, "agent_seed")).rejects.toThrow(
      /not yet implemented/,
    );
  });

  // Day 4 will add: agent_cap exhaustion, global_cap exhaustion, no_wallet
  // exhausted, sponsored success with tx_hash + ledger_id, opted_out path,
  // and integration with sendSponsorPayment. These five cases are deferred
  // until the stub is replaced — they would all fail today against the seed.
});
