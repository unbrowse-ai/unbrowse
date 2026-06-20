/**
 * Contract organ 98973c11 stage G1 — flywheel closure test.
 *
 * Asserts that `addSponsorPoolCredits` carves the configured fraction
 * of Stripe revenue into the sponsor pool, that re-delivered events
 * are idempotent, and that `drawFromSponsorPool` only fires when the
 * balance is sufficient.
 *
 * Per CLAUDE.md "Never mock in tests" — we hit the real
 * addSponsorPoolCredits / drawFromSponsorPool against the in-memory
 * LocalKV that statsKV() returns under ENVIRONMENT="local-dev" (same
 * pattern as sponsor-stripe-integration.test.ts).
 *
 * NOTE: an earlier version of makeEnv() only passed a raw STATS_KV
 * KVNamespace and omitted ENVIRONMENT. That made statsKV() throw
 * "EMERGENTDB_API_KEY is required" — statsKV() never reads env.STATS_KV
 * directly (it only wraps an EdbKV in FallbackKV when the EmergentDB key
 * is present); the only no-key in-memory path is ENVIRONMENT="local-dev"
 * → LocalKV. The sponsor-pool.ts kvGet/kvPut doc-comment claiming a raw
 * STATS_KV fallback is inaccurate, but the code is production-correct, so
 * the fix belongs here in the test env, not in the service.
 */

import { describe, expect, test, beforeEach } from "bun:test";
import {
  addSponsorPoolCredits,
  drawFromSponsorPool,
  getSponsorPoolBalance,
  DEFAULT_PLATFORM_REVENUE_TO_POOL_BPS,
} from "../src/services/sponsor-pool.js";
import type { Env } from "../src/types.js";
import { clearKVCacheForTests } from "../src/services/kv.js";

function makeEnv(overrides: Partial<Env> = {}): Env {
  return {
    // local-dev makes statsKV() return an in-memory LocalKV (no
    // EMERGENTDB_API_KEY needed). beforeEach's clearKVCacheForTests()
    // resets the shared LocalKV store so tests stay isolated.
    ENVIRONMENT: "local-dev",
    ...overrides,
  } as unknown as Env;
}

describe("sponsor-pool flywheel closure (G1)", () => {
  beforeEach(() => {
    clearKVCacheForTests();
  });

  test("default 10% carve when env unset (paper §3.5 default)", async () => {
    const env = makeEnv();
    const revenue = 100_000_000; // $1.00 in µ¢ (UC_PER_USD = 100_000_000)
    const result = await addSponsorPoolCredits(env, {
      event_id: "evt_test_default",
      source: "stripe_subscription_grant",
      revenue_uc: revenue,
    });
    expect(result.idempotent_skip).toBe(false);
    const expectedContribution = Math.floor(
      (revenue * DEFAULT_PLATFORM_REVENUE_TO_POOL_BPS) / 10000,
    );
    expect(result.added_uc).toBe(expectedContribution);
    expect(result.new_balance_uc).toBe(expectedContribution);
  });

  test("env override picks up custom bps", async () => {
    const env = makeEnv({ PLATFORM_REVENUE_TO_POOL_BPS: "2500" });
    const revenue = 100_000_000;
    const result = await addSponsorPoolCredits(env, {
      event_id: "evt_test_env_2500",
      source: "stripe_subscription_grant",
      revenue_uc: revenue,
    });
    expect(result.added_uc).toBe(Math.floor((revenue * 2500) / 10000));
  });

  test("rate_bps_override beats env (test-only knob)", async () => {
    const env = makeEnv({ PLATFORM_REVENUE_TO_POOL_BPS: "2500" });
    const result = await addSponsorPoolCredits(env, {
      event_id: "evt_test_override",
      source: "test",
      revenue_uc: 1_000_000,
      rate_bps_override: 5000, // 50%
    });
    expect(result.added_uc).toBe(500_000); // 50% of 1m µ¢
  });

  test("rate_bps=0 disables the pool feed (records journal, contributes 0)", async () => {
    const env = makeEnv({ PLATFORM_REVENUE_TO_POOL_BPS: "0" });
    const result = await addSponsorPoolCredits(env, {
      event_id: "evt_test_disabled",
      source: "test",
      revenue_uc: 100_000_000,
    });
    expect(result.added_uc).toBe(0);
    expect(result.idempotent_skip).toBe(false); // journal row was still written
  });

  test("re-delivered event with same event_id is idempotent (no double-credit)", async () => {
    const env = makeEnv();
    const args = {
      event_id: "evt_test_idem",
      source: "stripe_subscription_grant" as const,
      revenue_uc: 100_000_000,
    };
    const first = await addSponsorPoolCredits(env, args);
    expect(first.idempotent_skip).toBe(false);
    expect(first.added_uc).toBeGreaterThan(0);

    const second = await addSponsorPoolCredits(env, args);
    expect(second.idempotent_skip).toBe(true);
    expect(second.added_uc).toBe(0);
    // Balance unchanged
    expect(second.new_balance_uc).toBe(first.new_balance_uc);
  });

  test("multiple contributions accumulate in the pool", async () => {
    const env = makeEnv({ PLATFORM_REVENUE_TO_POOL_BPS: "1000" });
    await addSponsorPoolCredits(env, {
      event_id: "evt_1",
      source: "stripe_subscription_grant",
      revenue_uc: 100_000_000,
    });
    await addSponsorPoolCredits(env, {
      event_id: "evt_2",
      source: "stripe_autorefill",
      revenue_uc: 50_000_000,
    });
    const balance = await getSponsorPoolBalance(env);
    expect(balance).toBe(Math.floor(150_000_000 * 1000 / 10000)); // 15m µ¢ = $0.15
  });

  test("draw from pool succeeds when balance sufficient", async () => {
    const env = makeEnv({ PLATFORM_REVENUE_TO_POOL_BPS: "10000" }); // 100% — easier numerics
    await addSponsorPoolCredits(env, {
      event_id: "evt_seed",
      source: "test",
      revenue_uc: 1_000_000,
    });
    expect(await getSponsorPoolBalance(env)).toBe(1_000_000);

    const draw = await drawFromSponsorPool(env, {
      draw_id: "draw_1",
      spend_uc: 600_000,
    });
    expect(draw.drawn_uc).toBe(600_000);
    expect(draw.new_balance_uc).toBe(400_000);
    expect(await getSponsorPoolBalance(env)).toBe(400_000);
  });

  test("draw is idempotent on draw_id (retried request no-ops)", async () => {
    const env = makeEnv({ PLATFORM_REVENUE_TO_POOL_BPS: "10000" });
    await addSponsorPoolCredits(env, {
      event_id: "evt_seed_idem",
      source: "test",
      revenue_uc: 1_000_000,
    });
    const first = await drawFromSponsorPool(env, {
      draw_id: "draw_idem",
      spend_uc: 500_000,
    });
    expect(first.drawn_uc).toBe(500_000);
    expect(first.new_balance_uc).toBe(500_000);

    const second = await drawFromSponsorPool(env, {
      draw_id: "draw_idem",
      spend_uc: 500_000,
    });
    expect(second.idempotent_skip).toBe(true);
    expect(second.drawn_uc).toBe(0);
    // Balance unchanged from the first draw
    expect(await getSponsorPoolBalance(env)).toBe(500_000);
  });

  test("draw fails closed when balance insufficient (caller falls back to platform wallet)", async () => {
    const env = makeEnv({ PLATFORM_REVENUE_TO_POOL_BPS: "10000" });
    await addSponsorPoolCredits(env, {
      event_id: "evt_seed_small",
      source: "test",
      revenue_uc: 100_000, // small balance
    });
    const draw = await drawFromSponsorPool(env, {
      draw_id: "draw_too_big",
      spend_uc: 1_000_000, // more than the pool
    });
    expect(draw.drawn_uc).toBe(0);
    expect(draw.new_balance_uc).toBe(100_000); // unchanged
  });

  test("sub-µ¢ rounding to zero records a journal row but contributes 0", async () => {
    const env = makeEnv({ PLATFORM_REVENUE_TO_POOL_BPS: "1" }); // 0.01%
    const result = await addSponsorPoolCredits(env, {
      event_id: "evt_tiny",
      source: "test",
      revenue_uc: 100, // 100 µ¢ × 0.01% = 0.01 µ¢ → floor to 0
    });
    expect(result.added_uc).toBe(0);
    // Re-delivery still idempotent because the journal row exists
    const retry = await addSponsorPoolCredits(env, {
      event_id: "evt_tiny",
      source: "test",
      revenue_uc: 100,
    });
    expect(retry.idempotent_skip).toBe(true);
  });
});
