// Backend test: aggregateContributions — the load-bearing logic behind the
// per-route contributions ledger (plan node G3). Groups an agent's creator payout
// transactions by route (skill_id) into {reuse_count, earned_usd, last_used_at}.
// Every value is COUNTED from real transactions — nothing invented — so the test
// pins exactly that: counts, sums, latest-wins, sort-by-earnings, top-20 cap.
import { describe, it, expect } from "bun:test";
import { aggregateContributions, type DashboardTransaction } from "../src/services/economics.js";

function tx(skill_id: string, amount_usd: number, created_at: string, endpoint_id?: string): DashboardTransaction {
  return {
    transaction_id: `${skill_id}-${created_at}`,
    direction: "earned",
    skill_id,
    endpoint_id,
    amount_usd,
    platform_fee_usd: 0,
    counterparty_agent_id: "other",
    status: "settled",
    created_at,
  };
}

describe("aggregateContributions", () => {
  it("groups by route, counting reuse and summing earnings", () => {
    const out = aggregateContributions([
      tx("carousell.com/food", 0.10, "2026-06-01T00:00:00Z"),
      tx("carousell.com/food", 0.20, "2026-06-03T00:00:00Z"),
      tx("reddit.com/r", 0.05, "2026-06-02T00:00:00Z"),
    ]);
    const food = out.find((c) => c.skill_id === "carousell.com/food")!;
    expect(food.reuse_count).toBe(2);
    expect(food.earned_usd).toBeCloseTo(0.30, 6);
    expect(out.find((c) => c.skill_id === "reddit.com/r")!.reuse_count).toBe(1);
  });

  it("keeps the latest last_used_at and its endpoint", () => {
    const [c] = aggregateContributions([
      tx("s", 0.01, "2026-06-01T00:00:00Z", "ep-old"),
      tx("s", 0.01, "2026-06-09T00:00:00Z", "ep-new"),
      tx("s", 0.01, "2026-06-05T00:00:00Z", "ep-mid"),
    ]);
    expect(c.last_used_at).toBe("2026-06-09T00:00:00Z");
    expect(c.endpoint_id).toBe("ep-new"); // endpoint follows the most recent use
  });

  it("sorts routes by earnings descending", () => {
    const out = aggregateContributions([
      tx("low", 0.01, "2026-06-01T00:00:00Z"),
      tx("high", 5.00, "2026-06-01T00:00:00Z"),
      tx("mid", 1.00, "2026-06-01T00:00:00Z"),
    ]);
    expect(out.map((c) => c.skill_id)).toEqual(["high", "mid", "low"]);
  });

  it("caps at the top 20 routes", () => {
    const many = Array.from({ length: 30 }, (_, i) => tx(`route-${i}`, i + 1, "2026-06-01T00:00:00Z"));
    const out = aggregateContributions(many);
    expect(out.length).toBe(20);
    expect(out[0].skill_id).toBe("route-29"); // highest earner first
  });

  it("returns [] for no contributions (never fabricates a row)", () => {
    expect(aggregateContributions([])).toEqual([]);
  });
});
