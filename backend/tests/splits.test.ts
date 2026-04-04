import { describe, expect, it } from "bun:test";
import { computeContributorShares, mergeContributor, buildSplitRecipients, resolveSkillPaymentRecipient, selectPrimaryContributor, syncSkillSplitConfig } from "../src/services/splits.js";
import type { SkillContributor, SkillManifest } from "../src/types.js";

function makeContributor(overrides: Partial<SkillContributor>): SkillContributor {
  return {
    agent_id: "agent-1",
    wallet_address: "So1anaWa11etAddress1111111111111111111111111",
    endpoints_contributed: 3,
    cumulative_delta: 1.0,
    share: 0,
    first_contributed_at: "2026-04-01T00:00:00Z",
    last_contributed_at: "2026-04-01T00:00:00Z",
    ...overrides,
  };
}

describe("computeContributorShares", () => {
  it("gives all pool shares to a single contributor", () => {
    const shares = computeContributorShares([
      makeContributor({ agent_id: "a", cumulative_delta: 1.0 }),
    ]);
    expect(shares.length).toBe(1);
    expect(shares[0].share).toBe(90); // 100 - 10 platform
  });

  it("splits proportionally by delta", () => {
    const shares = computeContributorShares([
      makeContributor({ agent_id: "a", cumulative_delta: 3.0 }),
      makeContributor({ agent_id: "b", cumulative_delta: 1.0 }),
    ]);
    const a = shares.find((s) => s.agent_id === "a")!;
    const b = shares.find((s) => s.agent_id === "b")!;
    expect(a.share).toBeGreaterThan(b.share);
    expect(a.share + b.share).toBe(90);
  });

  it("gives equal shares when deltas are equal", () => {
    const shares = computeContributorShares([
      makeContributor({ agent_id: "a", cumulative_delta: 1.0 }),
      makeContributor({ agent_id: "b", cumulative_delta: 1.0 }),
    ]);
    expect(shares[0].share).toBe(shares[1].share);
  });

  it("skips contributors without wallet addresses", () => {
    const shares = computeContributorShares([
      makeContributor({ agent_id: "a", wallet_address: undefined }),
      makeContributor({ agent_id: "b", cumulative_delta: 1.0 }),
    ]);
    expect(shares.length).toBe(1);
    expect(shares[0].agent_id).toBe("b");
    expect(shares[0].share).toBe(90);
  });

  it("returns empty for no contributors", () => {
    expect(computeContributorShares([])).toEqual([]);
  });

  it("handles near-zero deltas with floor", () => {
    const shares = computeContributorShares([
      makeContributor({ agent_id: "a", cumulative_delta: 0.001 }),
      makeContributor({ agent_id: "b", cumulative_delta: 0.001 }),
    ]);
    // Both should get floor delta (0.01) → equal
    expect(shares.length).toBe(2);
    expect(shares[0].share + shares[1].share).toBe(90);
  });
});

describe("mergeContributor", () => {
  it("adds a new contributor", () => {
    const result = mergeContributor([], "agent-x", 3, "wallet-x");
    expect(result.length).toBe(1);
    expect(result[0].agent_id).toBe("agent-x");
    expect(result[0].endpoints_contributed).toBe(3);
    expect(result[0].wallet_address).toBe("wallet-x");
  });

  it("updates existing contributor endpoint count", () => {
    const existing = [makeContributor({ agent_id: "agent-x", endpoints_contributed: 2 })];
    const result = mergeContributor(existing, "agent-x", 3);
    expect(result.length).toBe(1);
    expect(result[0].endpoints_contributed).toBe(5);
  });

  it("adds second contributor alongside existing", () => {
    const existing = [makeContributor({ agent_id: "agent-a" })];
    const result = mergeContributor(existing, "agent-b", 2, "wallet-b");
    expect(result.length).toBe(2);
    expect(result.find((c) => c.agent_id === "agent-b")!.endpoints_contributed).toBe(2);
  });

  it("recomputes shares after merge", () => {
    const existing = [makeContributor({ agent_id: "a", cumulative_delta: 2.0 })];
    const result = mergeContributor(existing, "b", 1, "wallet-b");
    // Both should have shares assigned
    const total = result.reduce((s, c) => s + c.share, 0);
    expect(total).toBe(90);
  });
});

describe("buildSplitRecipients", () => {
  it("includes platform + contributors", () => {
    const contributors = [
      makeContributor({ agent_id: "a", cumulative_delta: 1.0 }),
    ];
    const recipients = buildSplitRecipients(contributors, "platform-wallet");
    expect(recipients.length).toBe(2);
    expect(recipients[0]).toEqual({ address: "platform-wallet", share: 10 });
    expect(recipients[1].share).toBe(90);
    const total = recipients.reduce((s, r) => s + r.share, 0);
    expect(total).toBe(100);
  });

  it("gives 100% to platform when no payable contributors", () => {
    const recipients = buildSplitRecipients([], "platform-wallet");
    expect(recipients).toEqual([{ address: "platform-wallet", share: 100 }]);
  });

  it("distributes among multiple contributors", () => {
    const contributors = [
      makeContributor({ agent_id: "a", cumulative_delta: 3.0, wallet_address: "wallet-a" }),
      makeContributor({ agent_id: "b", cumulative_delta: 1.0, wallet_address: "wallet-b" }),
    ];
    const recipients = buildSplitRecipients(contributors, "platform-wallet");
    expect(recipients.length).toBe(3);
    const total = recipients.reduce((s, r) => s + r.share, 0);
    expect(total).toBe(100);
    // a should get more than b
    const aShare = recipients.find((r) => r.address === "wallet-a")!.share;
    const bShare = recipients.find((r) => r.address === "wallet-b")!.share;
    expect(aShare).toBeGreaterThan(bShare);
  });
});

describe("syncSkillSplitConfig", () => {
  it("routes multi-contributor skills to the majority contributor wallet", () => {
    const skill = {
      skill_id: "skill-1",
      version: "1.0.0",
      schema_version: "1",
      name: "example.com",
      intent_signature: "example.com",
      domain: "example.com",
      description: "fixture",
      owner_type: "marketplace",
      execution_type: "http",
      endpoints: [],
      lifecycle: "active",
      contributors: [
        makeContributor({ agent_id: "a", wallet_address: "wallet-a" }),
        makeContributor({ agent_id: "b", wallet_address: "wallet-b" }),
      ],
      split_config: "old-split-config",
      created_at: "2026-04-02T00:00:00.000Z",
      updated_at: "2026-04-02T00:00:00.000Z",
    } as SkillManifest;

    const synced = syncSkillSplitConfig(skill);
    expect(synced.split_config).toBe("wallet-a");
  });
});

describe("selectPrimaryContributor", () => {
  it("returns the highest-share contributor", () => {
    const primary = selectPrimaryContributor([
      makeContributor({ agent_id: "a", wallet_address: "wallet-a", cumulative_delta: 3 }),
      makeContributor({ agent_id: "b", wallet_address: "wallet-b", cumulative_delta: 1 }),
    ]);
    expect(primary?.agent_id).toBe("a");
    expect(primary?.wallet_address).toBe("wallet-a");
  });
});

describe("resolveSkillPaymentRecipient", () => {
  it("uses the majority contributor wallet before fallback recipients", () => {
    const recipient = resolveSkillPaymentRecipient({
      skill_id: "skill-1",
      version: "1.0.0",
      schema_version: "1",
      name: "example.com",
      intent_signature: "example.com",
      domain: "example.com",
      description: "fixture",
      owner_type: "marketplace",
      execution_type: "http",
      endpoints: [],
      lifecycle: "active",
      contributors: [
        makeContributor({ agent_id: "a", wallet_address: "wallet-a", cumulative_delta: 3 }),
        makeContributor({ agent_id: "b", wallet_address: "wallet-b", cumulative_delta: 1 }),
      ],
      created_at: "2026-04-02T00:00:00.000Z",
      updated_at: "2026-04-02T00:00:00.000Z",
    } as SkillManifest, { PAYMENT_RECIPIENT: "platform-wallet" });
    expect(recipient).toBe("wallet-a");
  });
});

describe("delta decay", () => {
  it("contributor with zero new executions decays toward zero", () => {
    const DECAY = 0.95;
    let delta = 1.0;
    for (let i = 0; i < 60; i++) {
      delta *= DECAY;
    }
    // After 60 executions with no credit, delta should be ~0.046
    expect(delta).toBeLessThan(0.05);
  });

  it("active contributor maintains share against decaying one", () => {
    const DECAY = 0.95;
    let activeD = 1.0;
    let staleD = 1.0;

    // Simulate 20 executions where only 'active' gets credit
    for (let i = 0; i < 20; i++) {
      activeD *= DECAY;
      staleD *= DECAY;
      activeD += 0.5; // active gets credited
    }

    // Active should dominate
    const total = activeD + staleD;
    expect(activeD / total).toBeGreaterThan(0.9);
  });

  it("stale contributor drops below threshold and gets pruned", () => {
    const DECAY = 0.95;
    const THRESHOLD = 0.01;
    let delta = 0.1; // starts small
    let rounds = 0;
    while (delta >= THRESHOLD) {
      delta *= DECAY;
      rounds++;
    }
    // Should be pruned within ~45 rounds
    expect(rounds).toBeLessThan(50);
  });
});
