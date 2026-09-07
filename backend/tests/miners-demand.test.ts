import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { buildMinerDemandBoardFromEvents } from "../src/services/miner-demand-derive.js";

function isoHoursAgo(hours: number): string {
  return new Date(Date.now() - hours * 3600_000).toISOString();
}

describe("miners demand board", () => {
  beforeEach(() => {});
  afterEach(() => {});

  it("derives bounties and quests from recent telemetry demand", async () => {
    const events = [
      {
        install_id: "install-1",
        name: "resolve_started",
        source: "cli",
        host_type: "codex",
        created_at: isoHoursAgo(6),
        properties: { intent: "search docs", domain: "notion.so", url: "https://notion.so" },
      },
      {
        install_id: "install-2",
        name: "resolve_started",
        source: "cli",
        host_type: "codex",
        created_at: isoHoursAgo(5),
        properties: { intent: "get page comments", domain: "notion.so", url: "https://notion.so/page" },
      },
      {
        install_id: "install-1",
        name: "resolve_failed",
        source: "cli",
        host_type: "codex",
        created_at: isoHoursAgo(4),
        properties: { intent: "get page comments", domain: "notion.so", failure_reason: "missing_skill" },
      },
      {
        install_id: "install-3",
        name: "search_started",
        source: "cli",
        host_type: "codex",
        created_at: isoHoursAgo(3),
        properties: { intent: "create checkout session", domain: "stripe.com" },
      },
      {
        install_id: "install-3",
        name: "search_completed",
        source: "cli",
        host_type: "codex",
        created_at: isoHoursAgo(2),
        properties: { intent: "create checkout session", domain: "stripe.com", result_count: 2 },
      },
      {
        install_id: "install-4",
        name: "resolve_started",
        source: "cli",
        host_type: "codex",
        created_at: isoHoursAgo(2),
        properties: { intent: "get pull requests", domain: "github.com" },
      },
      {
        install_id: "install-4",
        name: "resolve_completed",
        source: "cli",
        host_type: "codex",
        created_at: isoHoursAgo(1),
        properties: { intent: "get pull requests", domain: "github.com" },
      },
    ];

    const board = buildMinerDemandBoardFromEvents(events, new Map([
      ["github.com", { endpoints: 24, skills: 1 }],
    ]));

    const body = board as {
      bounties: Array<{ domain: string; description: string; reward_multiplier: number }>;
      quests: Array<{ target_domain?: string; title: string }>;
    };

    expect(body.bounties.length).toBeGreaterThan(0);
    expect(body.bounties.some((bounty) =>
      bounty.domain === "notion.so" && bounty.description.includes("Recent asks:"),
    )).toBe(true);
    expect(body.bounties.some((bounty) =>
      bounty.domain === "stripe.com" && bounty.description.includes("create checkout session"),
    )).toBe(true);
    expect(body.quests[0]?.target_domain).toBe("notion.so");
    expect(body.quests.some((quest) => quest.title.includes("routes from demand targets"))).toBe(true);
  });
});
