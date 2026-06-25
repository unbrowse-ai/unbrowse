/**
 * Tests for the kickstart RBF math. Pure functions only — no ledger writes, no
 * I/O. The contract-bridge layer is separately responsible for persisting
 * StakeState. These tests gate the math that everything else depends on.
 */
import { describe, it, expect } from "bun:test";
import {
  DEFAULT_KICKSTART_TERMS,
  validateTerms,
  paybackTarget,
  geometricDecayRate,
  kickstartPayout,
  applyPayout,
  worstCaseWalletKeepBps,
  trackerAggregates,
  trackerVerdict,
  type StakeState,
  type KickstartTerms,
} from "../src/values/kickstart.js";

function stakeFixture(overrides: Partial<StakeState> = {}): StakeState {
  return {
    kickstart_commitment: "sha256:test",
    seeder: "seeder_pk",
    seeded: "seeded_pk",
    rate_bps: 500,
    payback_target_usd: 0.20,
    cumulative_payout_usd: 0,
    status: "active",
    expired_at: null,
    created_at: 1_700_000_000_000,
    ...overrides,
  };
}

describe("validateTerms", () => {
  it("accepts the default terms", () => {
    expect(validateTerms(DEFAULT_KICKSTART_TERMS)).toBeNull();
  });

  it("rejects rate_bps below 10 (0.1%)", () => {
    expect(validateTerms({ rate_bps: 5 })).toMatch(/out of bounds/);
  });

  it("rejects rate_bps above 2000 (20%)", () => {
    expect(validateTerms({ rate_bps: 2500 })).toMatch(/out of bounds/);
  });

  it("rejects amount_usd below 0.001", () => {
    expect(validateTerms({ amount_usd: 0.0001 })).toMatch(/out of bounds/);
  });

  it("rejects amount_usd above 100", () => {
    expect(validateTerms({ amount_usd: 200 })).toMatch(/out of bounds/);
  });

  it("rejects payback_multiple_x100 below 150 (1.5x)", () => {
    expect(validateTerms({ payback_multiple_x100: 100 })).toMatch(/out of bounds/);
  });
});

describe("paybackTarget", () => {
  it("$0.10 seed at 2x → $0.20 target", () => {
    expect(paybackTarget(0.10, 200)).toBeCloseTo(0.20, 6);
  });

  it("$1.00 seed at 1.5x → $1.50 target", () => {
    expect(paybackTarget(1.00, 150)).toBeCloseTo(1.50, 6);
  });
});

describe("geometricDecayRate", () => {
  const terms: KickstartTerms = { ...DEFAULT_KICKSTART_TERMS, rate_bps: 500, decay_factor: 4, depth_cap: 3 };

  it("depth 0 → full stake rate (500 bps / 4^0 = 500)", () => {
    expect(geometricDecayRate(500, 0, 4, 3)).toBe(500);
  });

  it("depth 1 → rate/4 (500/4 = 125 bps = 1.25%)", () => {
    expect(geometricDecayRate(500, 1, 4, 3)).toBe(125);
  });

  it("depth 2 → rate/16 (500/16 = 31.25 bps = 0.3125%)", () => {
    expect(geometricDecayRate(500, 2, 4, 3)).toBeCloseTo(31.25, 6);
  });

  it("depth 3 → 0 (cap reached)", () => {
    expect(geometricDecayRate(500, 3, 4, 3)).toBe(0);
  });

  it("negative depth → 0 (no inverted payouts)", () => {
    expect(geometricDecayRate(500, -1, 4, 3)).toBe(0);
  });
});

describe("kickstartPayout — single level", () => {
  it("takes 5% of capture revenue on an active stake", () => {
    const stake = stakeFixture();
    const result = kickstartPayout(stake, 1.00, "capture_1", 1_700_000_001_000);
    expect(result.seeder_take_usd).toBeCloseTo(0.05, 6);
    expect(result.seeded_keeps_usd).toBeCloseTo(0.95, 6);
    expect(result.cumulative_after_usd).toBeCloseTo(0.05, 6);
    expect(result.remaining_to_payback_usd).toBeCloseTo(0.15, 6);
    expect(result.stake_expired).toBe(false);
  });

  it("clamps seeder take to the payback target (no overpayment)", () => {
    const stake = stakeFixture({ cumulative_payout_usd: 0.18 }); // $0.02 remaining
    const result = kickstartPayout(stake, 1.00, "capture_2", 1_700_000_002_000);
    expect(result.seeder_take_usd).toBeCloseTo(0.02, 6); // not 0.05
    expect(result.seeded_keeps_usd).toBeCloseTo(0.98, 6);
    expect(result.cumulative_after_usd).toBeCloseTo(0.20, 6);
    expect(result.stake_expired).toBe(true);
  });

  it("returns zero take on an expired stake", () => {
    const stake = stakeFixture({ status: "expired", cumulative_payout_usd: 0.20, expired_at: 1_700_000_000_000 });
    const result = kickstartPayout(stake, 1.00, "capture_3", 1_700_000_003_000);
    expect(result.seeder_take_usd).toBe(0);
    expect(result.seeded_keeps_usd).toBe(1.00);
    expect(result.stake_expired).toBe(true);
  });

  it("returns zero take on a revoked stake", () => {
    const stake = stakeFixture({ status: "revoked" });
    const result = kickstartPayout(stake, 1.00, "capture_4", 1_700_000_004_000);
    expect(result.seeder_take_usd).toBe(0);
  });
});

describe("applyPayout", () => {
  it("updates cumulative payout on an active stake", () => {
    const stake = stakeFixture();
    const result = kickstartPayout(stake, 1.00, "c1", 1_700_000_001_000);
    const next = applyPayout(stake, result, 1_700_000_001_000);
    expect(next.cumulative_payout_usd).toBeCloseTo(0.05, 6);
    expect(next.status).toBe("active");
    expect(next.expired_at).toBeNull();
  });

  it("marks the stake expired when payback target reached", () => {
    const stake = stakeFixture({ cumulative_payout_usd: 0.18 });
    const result = kickstartPayout(stake, 1.00, "c2", 1_700_000_002_000);
    const next = applyPayout(stake, result, 1_700_000_002_000);
    expect(next.status).toBe("expired");
    expect(next.expired_at).toBe(1_700_000_002_000);
  });

  it("does not mutate the input stake", () => {
    const stake = stakeFixture();
    const result = kickstartPayout(stake, 1.00, "c3", 1_700_000_003_000);
    applyPayout(stake, result, 1_700_000_003_000);
    expect(stake.cumulative_payout_usd).toBe(0); // unchanged
    expect(stake.status).toBe("active");
  });

  it("is a no-op on an already-expired stake", () => {
    const stake = stakeFixture({ status: "expired", cumulative_payout_usd: 0.20 });
    const next = applyPayout(stake, {
      capture_event_id: "c4",
      capture_revenue_usd: 1.00,
      seeder_take_usd: 0,
      seeded_keeps_usd: 1.00,
      cumulative_after_usd: 0.20,
      remaining_to_payback_usd: 0,
      stake_expired: true,
    }, 1_700_000_004_000);
    expect(next).toBe(stake);
  });
});

describe("worstCaseWalletKeepBps", () => {
  it("returns 9343.75 bps for default terms (5%, factor 4, depth 3)", () => {
    // 10000 - 500 - 125 - 31.25 = 9343.75
    expect(worstCaseWalletKeepBps(DEFAULT_KICKSTART_TERMS)).toBeCloseTo(9343.75, 4);
  });

  it("returns 10000 bps when depth_cap is 0 (no upstream stakes count)", () => {
    expect(worstCaseWalletKeepBps({ ...DEFAULT_KICKSTART_TERMS, depth_cap: 0 })).toBe(10_000);
  });

  it("is non-negative for aggressive terms", () => {
    const aggressive = { ...DEFAULT_KICKSTART_TERMS, rate_bps: 2000, decay_factor: 2, depth_cap: 3 };
    // 10000 - 2000 - 1000 - 500 = 6500
    expect(worstCaseWalletKeepBps(aggressive)).toBeCloseTo(6500, 4);
  });
});

describe("trackerAggregates", () => {
  it("returns zeros for an empty stake set", () => {
    const a = trackerAggregates([]);
    expect(a.seeded_wallets_total).toBe(0);
    expect(a.seed_capital_deployed_usd).toBe(0);
    expect(a.dead_wood_rate).toBe(0);
  });

  it("counts active, expired, revoked correctly", () => {
    const stakes: StakeState[] = [
      stakeFixture({ seeded: "w1", status: "active", cumulative_payout_usd: 0.05 }),
      stakeFixture({ seeded: "w2", status: "active", cumulative_payout_usd: 0 }),
      stakeFixture({ seeded: "w3", status: "expired", cumulative_payout_usd: 0.20 }),
      stakeFixture({ seeded: "w4", status: "revoked" }),
    ];
    const a = trackerAggregates(stakes);
    expect(a.seeded_wallets_total).toBe(4);
    expect(a.active_stakes).toBe(2);
    expect(a.expired_stakes).toBe(1);
    expect(a.revoked_stakes).toBe(1);
    expect(a.dead_wood_count).toBe(1); // w2
    expect(a.dead_wood_rate).toBeCloseTo(0.25, 4); // 1 of 4
  });

  it("approximates seed_capital from payback_target / 2 (default 2x multiple)", () => {
    const stakes: StakeState[] = [
      stakeFixture({ seeded: "w1", payback_target_usd: 0.20 }),
    ];
    const a = trackerAggregates(stakes);
    expect(a.seed_capital_deployed_usd).toBeCloseTo(0.10, 6);
  });

  it("sums recovered_capital_usd across expired stakes", () => {
    const stakes: StakeState[] = [
      stakeFixture({ seeded: "w1", status: "expired", payback_target_usd: 0.20 }),
      stakeFixture({ seeded: "w2", status: "expired", payback_target_usd: 0.20 }),
    ];
    const a = trackerAggregates(stakes);
    expect(a.recovered_capital_usd).toBeCloseTo(0.40, 6);
  });

  it("sums pending_payback_usd across active stakes", () => {
    const stakes: StakeState[] = [
      stakeFixture({ seeded: "w1", status: "active", payback_target_usd: 0.20, cumulative_payout_usd: 0.05 }),
      stakeFixture({ seeded: "w2", status: "active", payback_target_usd: 0.20, cumulative_payout_usd: 0.10 }),
    ];
    const a = trackerAggregates(stakes);
    expect(a.pending_payback_usd).toBeCloseTo(0.25, 6); // 0.15 + 0.10
  });
});

describe("trackerVerdict", () => {
  it("returns 'witnessed' when both witnesses pass (low dead_wood + FDRY lift exceeds seed capital)", () => {
    const a = trackerAggregates([
      stakeFixture({ seeded: "w1", status: "active", cumulative_payout_usd: 0.05 }),
      stakeFixture({ seeded: "w2", status: "active", cumulative_payout_usd: 0.10 }),
    ]);
    // dead_wood_rate = 0/2 = 0 < 0.5 (W1 passes); FDRY lift 0.50 > seed_capital 0.20 (W2 passes)
    expect(trackerVerdict(a, 0.50)).toBe("witnessed");
  });

  it("returns 'incremental' when W1 passes but W2 fails (FDRY lift below seed capital)", () => {
    const a = trackerAggregates([
      stakeFixture({ seeded: "w1", status: "active", cumulative_payout_usd: 0.05 }),
      stakeFixture({ seeded: "w2", status: "active", cumulative_payout_usd: 0.10 }),
    ]);
    // dead_wood_rate = 0 (W1 passes); FDRY lift 0.10 < seed_capital 0.20 (W2 fails)
    expect(trackerVerdict(a, 0.10)).toBe("incremental");
  });

  it("returns 'incremental' when FDRY attribution is null (not computed)", () => {
    const a = trackerAggregates([
      stakeFixture({ seeded: "w1", status: "active", cumulative_payout_usd: 0.05 }),
    ]);
    expect(trackerVerdict(a, null)).toBe("incremental");
  });

  it("returns 'unwitnessed-feeling' when dead_wood_rate is high (most seeded wallets captured nothing)", () => {
    const a = trackerAggregates([
      stakeFixture({ seeded: "w1", status: "active", cumulative_payout_usd: 0 }),
      stakeFixture({ seeded: "w2", status: "active", cumulative_payout_usd: 0 }),
      stakeFixture({ seeded: "w3", status: "active", cumulative_payout_usd: 0.05 }),
    ]);
    // dead_wood_rate = 2/3 ≈ 0.667 ≥ 0.5 (W1 fails)
    expect(trackerVerdict(a, 10.0)).toBe("unwitnessed-feeling");
  });
});
